// Package drains forwards container logs to external HTTP sinks (log drains).
// Best-effort: it tails `docker logs -f` for each tugra_ container and POSTs
// batched lines to every configured drain. No retry/queue (MVP).
package drains

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	reconcileInterval = 15 * time.Second
	flushInterval     = 5 * time.Second
	maxBatchBytes     = 64 * 1024
)

// LogLine is one log line tagged with its source container.
type LogLine struct {
	Container string `json:"container"`
	Message   string `json:"message"`
}

// Batcher accumulates log lines and flushes them by size or on a timer.
type Batcher struct {
	maxBytes int
	flush    time.Duration
	out      func([]LogLine)

	mu    sync.Mutex
	buf   []LogLine
	bytes int
}

// NewBatcher creates a batcher that calls out with a batch when it reaches
// maxBytes or when Flush/the timer fires.
func NewBatcher(maxBytes int, flush time.Duration, out func([]LogLine)) *Batcher {
	return &Batcher{maxBytes: maxBytes, flush: flush, out: out}
}

// Add appends a line, flushing immediately if the buffer is full.
func (b *Batcher) Add(l LogLine) {
	b.mu.Lock()
	b.buf = append(b.buf, l)
	b.bytes += len(l.Message)
	full := b.bytes >= b.maxBytes
	b.mu.Unlock()
	if full {
		b.Flush()
	}
}

// Flush emits the buffered lines (if any) via out and resets the buffer.
func (b *Batcher) Flush() {
	b.mu.Lock()
	if len(b.buf) == 0 {
		b.mu.Unlock()
		return
	}
	batch := b.buf
	b.buf = nil
	b.bytes = 0
	b.mu.Unlock()
	b.out(batch)
}

// Run flushes on the timer until ctx is cancelled, then flushes once more.
func (b *Batcher) Run(ctx context.Context) {
	t := time.NewTicker(b.flush)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			b.Flush()
			return
		case <-t.C:
			b.Flush()
		}
	}
}

// postBatch ships a batch of lines to one drain. Best-effort (errors ignored).
func postBatch(client *http.Client, serverID string, d protocol.DrainCfg, lines []LogLine) error {
	body, err := json.Marshal(map[string]any{"server": serverID, "lines": lines})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, d.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if d.Token != "" {
		req.Header.Set("authorization", "Bearer "+d.Token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

// Forwarder owns the docker-log tails + batching for a server's drains.
type Forwarder struct {
	serverID string
	client   *http.Client

	mu     sync.Mutex
	drains []protocol.DrainCfg
	cancel context.CancelFunc // lifecycle of the reconcile+batch loops
}

// New creates a forwarder for the given server.
func New(serverID string) *Forwarder {
	return &Forwarder{serverID: serverID, client: &http.Client{Timeout: 10 * time.Second}}
}

// SetDrains applies a new drain config: starts forwarding when non-empty,
// stops it when empty. Safe to call repeatedly (e.g. on config_update).
func (f *Forwarder) SetDrains(parent context.Context, drains []protocol.DrainCfg) {
	f.mu.Lock()
	f.drains = drains
	if len(drains) == 0 {
		if f.cancel != nil {
			f.cancel()
			f.cancel = nil
		}
		f.mu.Unlock()
		return
	}
	if f.cancel != nil {
		f.mu.Unlock() // already running; reconcile/batcher read the latest drains
		return
	}
	ctx, cancel := context.WithCancel(parent)
	f.cancel = cancel
	f.mu.Unlock()

	batcher := NewBatcher(maxBatchBytes, flushInterval, func(lines []LogLine) {
		f.mu.Lock()
		current := f.drains
		f.mu.Unlock()
		for _, d := range current {
			_ = postBatch(f.client, f.serverID, d, lines)
		}
	})
	go batcher.Run(ctx)
	go f.reconcile(ctx, batcher)
}

// Stop tears down all tails.
func (f *Forwarder) Stop() {
	f.mu.Lock()
	if f.cancel != nil {
		f.cancel()
		f.cancel = nil
	}
	f.mu.Unlock()
}

// reconcile keeps one `docker logs -f` tail per running tugra_ container.
func (f *Forwarder) reconcile(ctx context.Context, b *Batcher) {
	tails := map[string]context.CancelFunc{}
	defer func() {
		for _, c := range tails {
			c()
		}
	}()
	run := func() {
		names := dockerPs(ctx)
		seen := map[string]bool{}
		for _, n := range names {
			seen[n] = true
			if _, ok := tails[n]; !ok {
				tctx, tcancel := context.WithCancel(ctx)
				tails[n] = tcancel
				go tailContainer(tctx, n, b)
			}
		}
		for n, c := range tails {
			if !seen[n] {
				c()
				delete(tails, n)
			}
		}
	}
	run()
	t := time.NewTicker(reconcileInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}

// dockerPs lists running tugra_ container names (best-effort, empty on error).
func dockerPs(ctx context.Context) []string {
	out, err := exec.CommandContext(ctx, "docker", "ps", "--format", "{{.Names}}", "--filter", "name=tugra_").Output()
	if err != nil {
		return nil
	}
	var names []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if l := strings.TrimSpace(line); l != "" {
			names = append(names, l)
		}
	}
	return names
}

// tailContainer streams a container's logs into the batcher until ctx ends.
func tailContainer(ctx context.Context, name string, b *Batcher) {
	cmd := exec.CommandContext(ctx, "docker", "logs", "-f", "--tail", "0", name)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return
	}
	cmd.Stderr = cmd.Stdout // merge stderr into the same stream
	if err := cmd.Start(); err != nil {
		return
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		b.Add(LogLine{Container: name, Message: scanner.Text()})
	}
	_ = cmd.Wait()
}
