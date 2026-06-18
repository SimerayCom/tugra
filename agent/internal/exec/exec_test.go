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
