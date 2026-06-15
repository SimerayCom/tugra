// Tugra agent — a single Go binary that runs on each managed server.
// Faz 0: skeleton only. Enrollment + metrics streaming land in Ay 2.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

// Version is overridden at build time via -ldflags "-X main.Version=...".
var Version = "0.0.0-dev"

// protocolVersion must match PROTOCOL_VERSION in packages/shared.
const protocolVersion = 1

func main() {
	hub := flag.String("hub", envOr("TUGRA_HUB", ""), "hub websocket URL, e.g. wss://hub.example.com")
	token := flag.String("token", envOr("TUGRA_TOKEN", ""), "enrollment token")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("tugra-agent %s (protocol %d)\n", Version, protocolVersion)
		return
	}

	log.Printf("tugra-agent %s starting (protocol %d)", Version, protocolVersion)

	if *hub == "" || *token == "" {
		log.Println("no --hub/--token provided; nothing to do yet (Faz 0 skeleton)")
		return
	}

	// TODO(Ay2): connect to hub, enroll, stream metrics + heartbeat, reconnect.
	log.Printf("would connect to %s and enroll", *hub)
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
