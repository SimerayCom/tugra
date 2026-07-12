package logs

import (
	"context"
	"os/exec"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBuildArgs(t *testing.T) {
	if got := buildArgs("tugra_app1", 200, "", true); !reflect.DeepEqual(got, []string{"logs", "--timestamps", "--tail", "200", "--follow", "tugra_app1"}) {
		t.Errorf("follow args = %v", got)
	}
	if got := buildArgs("c", 50, "", false); !reflect.DeepEqual(got, []string{"logs", "--timestamps", "--tail", "50", "c"}) {
		t.Errorf("no-follow args = %v", got)
	}
	if got := buildArgs("c", 100, "1h", true); !reflect.DeepEqual(got, []string{"logs", "--timestamps", "--tail", "100", "--since", "1h", "--follow", "c"}) {
		t.Errorf("since args = %v", got)
	}
}

// runCmd wires a single command's merged stdout to run() the same way Start does (no docker needed).
func runCmd(t *testing.T, cancel context.CancelFunc, cmd *exec.Cmd, onLine func(string), onExit func(int)) *Session {
	t.Helper()
	reader, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	cmd.Stderr = cmd.Stdout
	s, err := run(cancel, reader, []*exec.Cmd{cmd}, 0, onLine, onExit)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	return s
}

func TestRunStreamsLinesAndExitsOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "sh", "-c", "printf 'line-a\\nline-b\\n'")

	var mu sync.Mutex
	var lines []string
	var exits int32
	done := make(chan struct{})

	runCmd(t, cancel, cmd, func(l string) {
		mu.Lock()
		lines = append(lines, l)
		mu.Unlock()
	}, func(int) {
		atomic.AddInt32(&exits, 1)
		close(done)
	})
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("onExit never fired")
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(lines, []string{"line-a", "line-b"}) {
		t.Errorf("lines = %v", lines)
	}
	if atomic.LoadInt32(&exits) != 1 {
		t.Errorf("onExit fired %d times, want 1", exits)
	}
}

func TestCloseCancelsFollowOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	// Emit one line then block forever — stands in for `docker logs --follow`.
	cmd := exec.CommandContext(ctx, "sh", "-c", "printf 'started\\n'; sleep 60")

	var exits int32
	done := make(chan struct{})
	sess := runCmd(t, cancel, cmd, func(string) {}, func(int) {
		atomic.AddInt32(&exits, 1)
		close(done)
	})

	sess.Close()
	sess.Close() // idempotent — must not panic or double-reap

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not terminate the follow process")
	}
	if atomic.LoadInt32(&exits) != 1 {
		t.Errorf("onExit fired %d times, want 1", exits)
	}
}

// TestRunPartialStartFailureReapsStarted verifies that if a later command in the pipe fails to
// start, the already-started command is killed AND reaped (no zombie), and run returns the error.
func TestRunPartialStartFailureReapsStarted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	started := exec.CommandContext(ctx, "sh", "-c", "sleep 60") // starts fine
	failing := exec.CommandContext(ctx, "this-binary-does-not-exist-xyz-123")

	reader, err := started.StdoutPipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	// run should Start `started`, then fail to Start `failing`, cancel + Wait `started`, and return.
	if _, err := run(cancel, reader, []*exec.Cmd{started, failing}, 0, func(string) {}, func(int) {}); err == nil {
		t.Fatal("expected run to return the second command's start error")
	}
	// If `started` were left unreaped this call would race; a defensive Wait must be a no-op (already reaped).
	if started.ProcessState == nil {
		t.Error("the already-started process was not reaped (zombie leak)")
	}
}

// TestGrepPipeFiltersLines drives the two-process pipe (producer → grep) and asserts only matching
// lines are delivered, both processes are reaped, and onExit fires once.
func TestGrepPipeFiltersLines(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	producer := exec.CommandContext(ctx, "sh", "-c", "printf 'alpha\\nbeta\\ngamma\\n'")
	grep := exec.CommandContext(ctx, "grep", "--line-buffered", "-iF", "--", "ta")

	dockerOut, err := producer.StdoutPipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	producer.Stderr = producer.Stdout
	grep.Stdin = dockerOut
	reader, err := grep.StdoutPipe()
	if err != nil {
		t.Fatalf("grep pipe: %v", err)
	}

	var mu sync.Mutex
	var lines []string
	var exits int32
	done := make(chan struct{})
	if _, err := run(cancel, reader, []*exec.Cmd{producer, grep}, 0, func(l string) {
		mu.Lock()
		lines = append(lines, l)
		mu.Unlock()
	}, func(int) {
		atomic.AddInt32(&exits, 1)
		close(done)
	}); err != nil {
		t.Fatalf("run: %v", err)
	}

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("onExit never fired")
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(lines, []string{"beta"}) { // only "beta" contains "ta"
		t.Errorf("grep-filtered lines = %v, want [beta]", lines)
	}
	if atomic.LoadInt32(&exits) != 1 {
		t.Errorf("onExit fired %d times, want 1", exits)
	}
}
