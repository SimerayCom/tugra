package main

import (
	"testing"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

func TestProtocolVersionMatchesShared(t *testing.T) {
	// Must stay in sync with PROTOCOL_VERSION in packages/shared.
	if protocol.Version != 2 {
		t.Fatalf("expected protocol version 2, got %d", protocol.Version)
	}
}

func TestEnvOrFallback(t *testing.T) {
	if got := envOr("TUGRA_DEFINITELY_NOT_SET_XYZ", "fallback"); got != "fallback" {
		t.Fatalf("expected %q, got %q", "fallback", got)
	}
}

func TestEnvOrReadsEnv(t *testing.T) {
	t.Setenv("TUGRA_TEST_KEY", "value")
	if got := envOr("TUGRA_TEST_KEY", "fallback"); got != "value" {
		t.Fatalf("expected %q, got %q", "value", got)
	}
}
