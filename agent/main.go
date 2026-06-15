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
	"syscall"
	"time"

	"github.com/mrcandev/tugra/agent/internal/client"
	"github.com/mrcandev/tugra/agent/internal/config"
	"github.com/mrcandev/tugra/agent/internal/keys"
)

// Version is overridden at build time via -ldflags "-X main.Version=...".
var Version = "0.0.0-dev"

// protocolVersion must match PROTOCOL_VERSION in packages/shared.
const protocolVersion = 1

func main() {
	hub := flag.String("hub", envOr("TUGRA_HUB", ""), "hub websocket URL, e.g. wss://hub.example.com/agent")
	token := flag.String("token", envOr("TUGRA_TOKEN", ""), "enrollment token (first run only)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("tugra-agent %s (protocol %d)\n", Version, protocolVersion)
		return
	}
	if *hub == "" {
		log.Println("no --hub provided; nothing to do")
		return
	}

	home, _ := os.UserHomeDir()
	cfg := config.Config{
		HubURL:    *hub,
		Token:     *token,
		Version:   Version,
		KeyPath:   filepath.Join(home, ".tugra", "agent.key"),
		StatePath: filepath.Join(home, ".tugra", "agent.json"),
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
