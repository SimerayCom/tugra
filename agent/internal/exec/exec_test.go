package exec

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestRunSuccess(t *testing.T) {
	r := Run(context.Background(), "echo hi", 5*time.Second)
	if r.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", r.ExitCode)
	}
	if !strings.Contains(r.Output, "hi") {
		t.Fatalf("expected output to contain 'hi', got %q", r.Output)
	}
}

func TestRunNonZeroExit(t *testing.T) {
	r := Run(context.Background(), "exit 3", 5*time.Second)
	if r.ExitCode != 3 {
		t.Fatalf("expected exit 3, got %d", r.ExitCode)
	}
}
