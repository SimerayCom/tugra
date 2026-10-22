package exec

import (
	"context"
	"fmt"
	"strings"
	"sync"
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

// The hub's backup/restore scripts begin with `set -o pipefail`, which dash < 0.5.13
// rejects outright ("Illegal option -o pipefail", exit 2) — that silently broke every
// database backup. Run must use a shell that accepts the option.
func TestRunAcceptsPipefail(t *testing.T) {
	r := Run(context.Background(), "set -e\nset -o pipefail\necho ok", 5*time.Second)
	if r.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d (output: %q)", r.ExitCode, r.Output)
	}
	if strings.Contains(r.Output, "Illegal option") {
		t.Fatalf("shell rejected pipefail: %q", r.Output)
	}
	if !strings.Contains(r.Output, "ok") {
		t.Fatalf("expected output 'ok', got %q", r.Output)
	}
}

// pipefail must be ACTIVE, not merely accepted: a failing producer in a pipe (a failed
// pg_dump in `pg_dump | gzip > file`) must abort, or a truncated backup would be recorded
// as SUCCESS. With set -e + pipefail the failure stops the script before the next line.
func TestRunPipefailIsActive(t *testing.T) {
	r := Run(context.Background(), "set -e\nset -o pipefail\nfalse | cat\necho unreachable", 5*time.Second)
	if r.ExitCode == 0 {
		t.Fatalf("expected non-zero exit from a failed producer under pipefail, got 0 (output: %q)", r.Output)
	}
	if strings.Contains(r.Output, "unreachable") {
		t.Fatalf("pipefail inactive: a failed producer did not abort the script (output: %q)", r.Output)
	}
}

func TestRunStreamingEmitsChunks(t *testing.T) {
	var mu sync.Mutex
	var chunks []string
	r := RunStreaming(context.Background(), "echo out; echo err 1>&2", 5*time.Second, func(c string) {
		mu.Lock()
		chunks = append(chunks, c)
		mu.Unlock()
	})
	if r.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", r.ExitCode)
	}
	if len(chunks) == 0 {
		t.Fatal("expected at least one streamed chunk")
	}
	joined := strings.Join(chunks, "")
	// both stdout and stderr are captured and streamed
	if !strings.Contains(joined, "out") || !strings.Contains(joined, "err") {
		t.Fatalf("expected streamed chunks to contain stdout+stderr, got %q", joined)
	}
	// the accumulated Output mirrors the streamed content
	if !strings.Contains(r.Output, "out") || !strings.Contains(r.Output, "err") {
		t.Fatalf("expected Output to contain stdout+stderr, got %q", r.Output)
	}
}

func TestRunStreamingCapsOutputNotStream(t *testing.T) {
	// Print ~128KB; Output is capped at maxOutput but the live stream is not.
	cmd := fmt.Sprintf("yes x | head -c %d", 128*1024)
	var streamed int
	r := RunStreaming(context.Background(), cmd, 10*time.Second, func(c string) {
		streamed += len(c)
	})
	if r.ExitCode != 0 {
		t.Fatalf("expected exit 0, got %d", r.ExitCode)
	}
	if len(r.Output) > maxOutput+len("\n…(truncated)") {
		t.Fatalf("expected Output capped near %d, got %d", maxOutput, len(r.Output))
	}
	if streamed <= maxOutput {
		t.Fatalf("expected live stream uncapped (>%d), got %d", maxOutput, streamed)
	}
}
