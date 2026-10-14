// Package drains forwards container logs to external HTTP sinks (log drains).
// Best-effort: it tails `docker logs -f` for each tugra_ container and POSTs
// batched lines to every configured drain. No retry/queue (MVP).
package drains

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// maxAttempts bounds the per-batch delivery retries (transient errors / 5xx only).
const maxAttempts = 3

const (
	reconcileInterval = 15 * time.Second
	flushInterval     = 5 * time.Second
	maxBatchBytes     = 64 * 1024
	// Cap entries per batch so a burst of tiny lines can't blow past provider per-request limits
	// (Datadog's logs intake rejects > 1000 entries with a 413).
	maxBatchLines = 1000
	// Overall per-drain send budget (across retries) so a dead drain can't wedge the log-tail goroutine.
	batchSendBudget = 15 * time.Second
)

// LogLine is one log line tagged with its source container.
type LogLine struct {
	Container string `json:"container"`
	Message   string `json:"message"`
}

// Batcher accumulates log lines and flushes them by size, by entry count, or on a timer.
type Batcher struct {
	maxBytes int
	maxLines int
	flush    time.Duration
	out      func([]LogLine)

	mu    sync.Mutex
	buf   []LogLine
	bytes int
}

// NewBatcher creates a batcher that calls out with a batch when it reaches maxBytes OR maxLines entries, or
// when Flush/the timer fires. maxLines <= 0 means no entry-count cap.
func NewBatcher(maxBytes, maxLines int, flush time.Duration, out func([]LogLine)) *Batcher {
	return &Batcher{maxBytes: maxBytes, maxLines: maxLines, flush: flush, out: out}
}

// Add appends a line, flushing immediately if the buffer is full (by bytes or entry count).
func (b *Batcher) Add(l LogLine) {
	b.mu.Lock()
	b.buf = append(b.buf, l)
	b.bytes += len(l.Message)
	full := b.bytes >= b.maxBytes || (b.maxLines > 0 && len(b.buf) >= b.maxLines)
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

// format builds the HTTP body + headers for one drain, selected by its Type. Pure (no I/O) so it is unit-tested
// directly. `now` seeds Loki's per-line nanosecond timestamps, which must be unique + ascending within a stream.
func format(d protocol.DrainCfg, serverID string, lines []LogLine, now time.Time) ([]byte, map[string]string, error) {
	headers := map[string]string{"content-type": "application/json"}
	switch strings.ToLower(d.Type) {
	case "loki":
		type stream struct {
			Stream map[string]string `json:"stream"`
			Values [][2]string       `json:"values"`
		}
		idxByContainer := map[string]int{}
		var streams []stream
		base := now.UnixNano()
		for i, l := range lines {
			ts := strconv.FormatInt(base+int64(i), 10) // unique + ascending per line (Loki rejects out-of-order)
			idx, ok := idxByContainer[l.Container]
			if !ok {
				idx = len(streams)
				idxByContainer[l.Container] = idx
				streams = append(streams, stream{Stream: map[string]string{"host": serverID, "job": "tugra", "container": l.Container}})
			}
			streams[idx].Values = append(streams[idx].Values, [2]string{ts, l.Message})
		}
		body, err := json.Marshal(map[string]any{"streams": streams})
		if d.Token != "" {
			headers["authorization"] = "Bearer " + d.Token
		}
		return body, headers, err
	case "datadog":
		items := make([]map[string]string, len(lines))
		for i, l := range lines {
			items[i] = map[string]string{"message": l.Message, "ddsource": "tugra", "service": "tugra", "hostname": serverID, "ddtags": "container:" + l.Container}
		}
		body, err := json.Marshal(items)
		if d.Token != "" {
			headers["dd-api-key"] = d.Token // Datadog authenticates with DD-API-KEY, not a Bearer
		}
		return body, headers, err
	default: // "http", "" or a legacy "HTTP" row — Tugra's generic batch JSON
		body, err := json.Marshal(map[string]any{"server": serverID, "lines": lines})
		if d.Token != "" {
			headers["authorization"] = "Bearer " + d.Token
		}
		return body, headers, err
	}
}

// retriable reports whether an HTTP status is worth retrying: transient server errors (5xx) and the two
// transient 4xx the log providers use — 429 (rate limited, Loki/Datadog) and 408 (request timeout, Datadog).
func retriable(code int) bool {
	return code >= 500 || code == 429 || code == 408
}

// postBatch ships a batch to one drain, formatted for its type, with a few bounded retries. Best-effort — a
// permanent 4xx (bad config) is NOT retried; a network error, a 5xx, or a 429/408 is, then the final error is
// returned (ignored by the caller). The whole send shares one budget (batchSendBudget) via a context deadline,
// so a dead or slow drain can't wedge the log-tail goroutine for longer than that regardless of retries.
func postBatch(client *http.Client, serverID string, d protocol.DrainCfg, lines []LogLine) error {
	body, headers, err := format(d, serverID, lines, time.Now())
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), batchSendBudget)
	defer cancel()
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return lastErr
			case <-time.After(time.Duration(attempt) * 300 * time.Millisecond):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.Endpoint, bytes.NewReader(body))
		if err != nil {
			return err
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return lastErr // budget exhausted — stop
			}
			continue
		}
		code := resp.StatusCode
		_ = resp.Body.Close()
		if code >= 200 && code < 300 {
			return nil
		}
		lastErr = fmt.Errorf("drain %s returned HTTP %d", d.Endpoint, code)
		if !retriable(code) {
			return lastErr // permanent client error — retrying won't help
		}
	}
	return lastErr
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

	batcher := NewBatcher(maxBatchBytes, maxBatchLines, flushInterval, func(lines []LogLine) {
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
