// Tugra agent — a single Go binary that runs on each managed server.
// It dials OUT to the hub over WebSocket (no inbound port), enrolls, and
// streams metrics.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/client"
	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/ctrfs"
	"github.com/SimerayCom/tugra/agent/internal/endpoints"
	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/hostinfo"
	"github.com/SimerayCom/tugra/agent/internal/journal"
	"github.com/SimerayCom/tugra/agent/internal/keys"
	"github.com/SimerayCom/tugra/agent/internal/migrate"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// Version is overridden at build time via -ldflags "-X main.Version=...".
var Version = "0.0.0-dev"

func main() {
	// The `fsd` subcommand re-invokes this same binary INSIDE the sandboxed helper container
	// (see internal/fsd/launch.go). It must run before flag.Parse touches os.Args, takes no hub
	// connection, and exits with the helper's status code.
	// `hostips` prints the interface IPs as JSON and exits. The agent runs it in a short-lived helper container on
	// the HOST network (internal/hostinfo/host.go) because its own container only sees a docker-bridge address.
	if len(os.Args) > 1 && os.Args[1] == "hostips" {
		os.Exit(hostinfo.PrintHostIPs())
	}

	// `hostmeta` is the same helper container asking the cloud metadata service for the instance's public IPs.
	if len(os.Args) > 1 && os.Args[1] == "hostmeta" {
		os.Exit(hostinfo.PrintCloudIPs(os.Stdout))
	}

	if len(os.Args) > 1 && os.Args[1] == "fsd" {
		os.Exit(fsd.RunCLI(os.Args[2:]))
	}

	// `fsd2` is the write-capable sibling of `fsd` (internal/fsd/ops2.go): same sandboxed-container contract,
	// `--key=value` argv, JSON (or raw file bytes for `read`) on stdout, a typed "fsd: [code] msg" on stderr.
	if len(os.Args) > 1 && os.Args[1] == "fsd2" {
		os.Exit(fsd.RunCLI2(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}

	// The `migrate` subcommand is the one-click data migrator (S4-3). Like fsd it runs before
	// flag.Parse, opens NO hub WebSocket, installs its own signals, and exits with its own code.
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		os.Exit(migrate.RunCLI(os.Args[2:], Version, os.Stdout, os.Stderr))
	}

	hub := flag.String("hub", envOr("TUGRA_HUB", ""), "hub websocket URL, e.g. wss://hub.example.com/agent")
	hubPin := flag.String("hub-pin", envOr("TUGRA_HUB_PIN", ""), "sha256 fingerprint of the hub's leaf certificate (sha256:<hex>) for a hub on a bare IP with a self-signed certificate")
	hubInsecure := flag.Bool("hub-insecure", envOr("TUGRA_HUB_INSECURE", "") == "1", "explicit opt-in to a plain ws:// hub URL (traffic, including secrets, is readable on the network)")
	token := flag.String("token", envOr("TUGRA_TOKEN", ""), "enrollment token (first run only)")
	caps := flag.String("caps", envOr("TUGRA_CAPS", ""), "\"all\" to disable the fail-closed allowlist (operator/upgrade escape); otherwise the hub pushes the granted set — a bootstrap list here is only used before the hub connects")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("tugra-agent %s (protocol %d)\n", Version, protocol.Version)
		return
	}
	if *hub == "" {
		log.Println("no --hub provided; nothing to do")
		return
	}

	// "all" is an explicit escape hatch that disables the fail-closed allowlist; any other value is
	// a pre-handshake bootstrap list (the hub pushes the authoritative set on connect).
	capsBypass := strings.EqualFold(strings.TrimSpace(*caps), "all")
	var bootstrapCaps []string
	if !capsBypass {
		bootstrapCaps = parseCaps(*caps)
	}
	home, _ := os.UserHomeDir()
	bootstrap := endpoints.Endpoint{URL: strings.TrimSpace(*hub)}
	if p := strings.TrimSpace(*hubPin); p != "" {
		norm, err := endpoints.NormalizePin(p)
		if err != nil {
			log.Fatalf("invalid --hub-pin: %v", err)
		}
		bootstrap.Pin = norm
	}
	store, _ := config.LoadStore(filepath.Join(home, ".tugra", "agent.json"))
	// A plain ws:// install that already enrolled before this policy existed keeps working (grandfathered, warned);
	// a NEW plain ws:// install needs the explicit --hub-insecure.
	insecure := *hubInsecure || (store.ServerID != "" && endpoints.IsPlain(bootstrap.URL))
	mgr, err := endpoints.Open(filepath.Join(home, ".tugra", "endpoints.json"), bootstrap, insecure)
	if err != nil {
		log.Printf("warning: could not persist the hub endpoint list (%v); continuing with it in memory", err)
	}
	if err := endpoints.CheckURL(bootstrap, mgr.AllowPlain()); err != nil {
		log.Fatalf("%v", err)
	}
	if endpoints.IsPlain(bootstrap.URL) {
		if u, perr := url.Parse(bootstrap.URL); perr == nil && !endpoints.IsLoopbackOrInternal(u.Hostname()) {
			log.Printf("WARNING: the hub is reached over plain ws:// - commands are signed but environment values and secrets travel readable on the network. Use a wss:// hub address.")
		}
	}
	cfg := config.Config{
		HubURL:       bootstrap.URL,
		HubPin:       bootstrap.Pin,
		CACertPath:   filepath.Join(home, ".tugra", "hub-cert.pem"),
		RepinHubKey:  envOr("TUGRA_HUB_REPIN", "") == "1",
		Token:        *token,
		Version:      Version,
		KeyPath:      filepath.Join(home, ".tugra", "agent.key"),
		StatePath:    filepath.Join(home, ".tugra", "agent.json"),
		Capabilities: bootstrapCaps,
		CapsBypass:   capsBypass,
		// The agent's own image, re-invoked as the sandboxed fsd helper. Learned locally
		// (install/compose sets it), never from the hub. Empty ⇒ file ops stay unavailable (fail-closed).
		AgentImage: envOr("TUGRA_AGENT_IMAGE", ""),
		// Durable command journal next to the identity files (same persisted volume): deploys dispatched as
		// `durable` survive a hub restart / socket drop and the hub can recover their outcome.
		Journal: journal.New(filepath.Join(home, ".tugra", "journal")),
	}

	// Container-filesystem uploads are staged (verified) under ~/.tugra/fsx before the container sees them; drop any a
	// crash left behind.
	ctrfs.SweepStage(time.Hour)

	kp, err := keys.LoadOrCreate(cfg.KeyPath)
	if err != nil {
		log.Fatalf("key error: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("tugra-agent %s connecting to %s", Version, mgr.Primary().URL)
	client.Supervise(ctx, cfg, kp, store, mgr)
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}

// parseCaps turns "deploy, terminal" into ["deploy","terminal"]; empty → nil. Enforcement is
// fail-closed, so an empty list denies everything until the hub pushes the granted set.
func parseCaps(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
