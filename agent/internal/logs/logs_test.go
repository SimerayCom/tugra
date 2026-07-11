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
	if got := buildArgs("tugra_app1", 200, true); !reflect.DeepEqual(got, []string{"logs", "--timestamps", "--tail", "200", "--follow", "tugra_app1"}) {
		t.Errorf("follow args = %v", got)
	}
	if got := buildArgs("c", 50, false); !reflect.DeepEqual(got, []string{"logs", "--timestamps", "--tail", "50", "c"}) {
		t.Errorf("no-follow args = %v", got)
	}
}

// TestRunStreamsLinesAndExitsOnce drives run() with a controlled shell command (no docker) that
// prints two lines then exits, asserting each line is delivered and onExit fires exactly once.
func TestRunStreamsLinesAndExitsOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "sh", "-c", "printf 'line-a\\nline-b\\n'")

	var mu sync.Mutex
	var lines []string
	var exits int32
	done := make(chan struct{})

	_, err := run(cancel, cmd, func(l string) {
		mu.Lock()
		lines = append(lines, l)
		mu.Unlock()
	}, func(int) {
		atomic.AddInt32(&exits, 1)
		close(done)
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
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

// TestCloseCancelsFollowOnce simulates a `--follow` (a process that never exits on its own) and
// verifies Close() terminates it, onExit fires exactly once, and Close is idempotent.
func TestCloseCancelsFollowOnce(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	// Emit one line then block forever — stands in for `docker logs --follow`.
	cmd := exec.CommandContext(ctx, "sh", "-c", "printf 'started\\n'; sleep 60")

	var exits int32
	done := make(chan struct{})
	sess, err := run(cancel, cmd, func(string) {}, func(int) {
		atomic.AddInt32(&exits, 1)
		close(done)
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}

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
