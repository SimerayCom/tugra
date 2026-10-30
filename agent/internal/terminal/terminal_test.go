package terminal

import (
	"strings"
	"sync"
	"testing"
	"time"
)

// collector accumulates streamed PTY output in a goroutine-safe way.
type collector struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (c *collector) add(b []byte) {
	c.mu.Lock()
	c.buf.Write(b)
	c.mu.Unlock()
}

func (c *collector) string() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met within timeout")
}

func TestHostShellRoundTrip(t *testing.T) {
	out := &collector{}
	var exitCode int
	var exited bool
	var mu sync.Mutex
	s, err := Start("", 80, 24, out.add, func(code int) {
		mu.Lock()
		exitCode, exited = code, true
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := s.Write([]byte("echo hi-there\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	waitFor(t, func() bool { return strings.Contains(out.string(), "hi-there") })

	if _, err := s.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return exited })
	mu.Lock()
	defer mu.Unlock()
	if exitCode != 0 {
		t.Fatalf("expected exit 0, got %d", exitCode)
	}
}

func TestRejectsUnsafeContainerTarget(t *testing.T) {
	// A leading "-" (docker-exec option injection) and shell metacharacters must be refused before exec.
	for _, bad := range []string{"-it", "--privileged", "a b", "a;b", "a$(x)", "a|b", ""} {
		if bad == "" {
			continue // "" is the host shell, handled separately
		}
		if _, err := Start(bad, 80, 24, func([]byte) {}, nil); err == nil {
			t.Fatalf("expected Start(%q) to be rejected", bad)
		}
	}
}

func TestResizeAppliesToPty(t *testing.T) {
	out := &collector{}
	s, err := Start("", 80, 24, out.add, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	defer s.Close()
	if err := s.Resize(120, 40); err != nil {
		t.Fatalf("resize: %v", err)
	}
	if _, err := s.Write([]byte("stty size\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	// `stty size` prints "rows cols" → "40 120"
	waitFor(t, func() bool { return strings.Contains(out.string(), "40 120") })
}

func TestCloseTerminatesSessionOnce(t *testing.T) {
	var calls int
	var mu sync.Mutex
	// `cat` blocks waiting on stdin and never exits on its own.
	s, err := Start("", 80, 24, func([]byte) {}, func(int) {
		mu.Lock()
		calls++
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if _, err := s.Write([]byte("cat\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	s.Close()
	s.Close() // idempotent — must not double-Wait or double-fire onExit
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return calls == 1 })
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("expected onExit once, got %d", calls)
	}
}
