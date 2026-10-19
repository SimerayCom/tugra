// Tugra agent — a single Go binary that runs on each managed server.
// It dials OUT to the hub over WebSocket (no inbound port), enrolls, and
// streams metrics.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/client"
	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/keys"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// Version is overridden at build time via -ldflags "-X main.Version=...".
var Version = "0.0.0-dev"

func main() {
	// The `fsd` subcommand re-invokes this same binary INSIDE the sandboxed helper container
	// (see internal/fsd/launch.go). It must run before flag.Parse touches os.Args, takes no hub
	// connection, and exits with the helper's status code.
	if len(os.Args) > 1 && os.Args[1] == "fsd" {
		os.Exit(fsd.RunCLI(os.Args[2:]))
	}

	hub := flag.String("hub", envOr("TUGRA_HUB", ""), "hub websocket URL, e.g. wss://hub.example.com/agent")
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
	cfg := config.Config{
		HubURL:       *hub,
		Token:        *token,
		Version:      Version,
		KeyPath:      filepath.Join(home, ".tugra", "agent.key"),
		StatePath:    filepath.Join(home, ".tugra", "agent.json"),
		Capabilities: bootstrapCaps,
		CapsBypass:   capsBypass,
	}

	kp, err := keys.LoadOrCreate(cfg.KeyPath)
	if err != nil {
		log.Fatalf("key error: %v", err)
	}
	store, _ := config.LoadStore(cfg.StatePath)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("tugra-agent %s connecting to %s", Version, cfg.HubURL)
	backoff := time.Second
	for ctx.Err() == nil {
		if err := client.Run(ctx, cfg, kp, store); err != nil && ctx.Err() == nil {
			log.Printf("connection error: %v; retrying in %s", err, backoff)
			select {
			case <-ctx.Done():
			case <-time.After(backoff):
			}
			if backoff < 30*time.Second {
				backoff *= 2
			}
			continue
		}
		backoff = time.Second
	}
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
