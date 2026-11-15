// Package drains forwards container logs to external sinks (log drains): HTTP (generic/Loki/Datadog), syslog
// (RFC 5424), GELF and fluentd Forward. Best-effort: it tails `docker logs -f` for the containers some drain
// wants and hands every batch to each drain's own bounded queue + sender goroutine, so a dead sink never stalls
// the tails or another sink. No persistence: lines emitted while the agent is disconnected are lost.
package drains

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
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
	// TS is the docker log timestamp (`-t`), zero when unparsable. Stream is "stdout" or "stderr". Both are
	// excluded from the http/loki/datadog JSON so those wire formats stay byte-identical to before D7.
	TS     time.Time `json:"-"`
	Stream string    `json:"-"`
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
// so a dead or slow drain can't wedge the log-tail goroutine for longer than that regardless of retries. The budget
// derives from `parent` (the sink's context): removing the drain or revoking `logs` cancels an in-flight request
// and stops the retry loop at once.
func postBatch(parent context.Context, client *http.Client, serverID string, d protocol.DrainCfg, lines []LogLine) error {
	body, headers, err := format(d, serverID, lines, time.Now())
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(parent, batchSendBudget)
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
		lastErr = &httpStatusErr{endpoint: d.Endpoint, code: code}
		if !retriable(code) {
			return lastErr // permanent client error — retrying won't help
		}
	}
	return lastErr
}

// Option configures a Forwarder.
type Option func(*Forwarder)

// WithStatusReporter makes the forwarder report per-sink status (every 30 s and on state change, debounced 1 s).
func WithStatusReporter(fn func(protocol.DrainStatusMsg)) Option {
	return func(f *Forwarder) { f.report = fn }
}

// Forwarder owns the docker-log tails + the per-drain sinks for a server.
type Forwarder struct {
	serverID string
	report   func(protocol.DrainStatusMsg)
	// docker / sender hooks, captured from the package vars at New() so background goroutines never race a
	// test that swaps the package vars.
	ps         func(context.Context) []psEntry
	tail       func(context.Context, string, time.Time, func(LogLine)) <-chan struct{}
	makeSender func(protocol.DrainCfg, string) (Sender, error)

	mu      sync.Mutex
	sinks   map[string]*sink
	invalid map[string]string // drain id -> error class, for drains that could not be built
	parent  context.Context
	tailCtx context.CancelFunc // lifecycle of the reconcile + batcher loops
	statCtx context.CancelFunc // lifecycle of the status loop
	changed chan struct{}      // status "something changed" (cap 1)
}

// New creates a forwarder for the given server.
func New(serverID string, opts ...Option) *Forwarder {
	f := &Forwarder{serverID: serverID, ps: psFn, tail: tailFn, makeSender: senderFactory, sinks: map[string]*sink{}, invalid: map[string]string{}, changed: make(chan struct{}, 1)}
	for _, o := range opts {
		o(f)
	}
	return f
}

// SetDrains applies a LEGACY drain set (plain server-wide http/loki/datadog from the unsigned "log_drains"
// frame): starts forwarding when non-empty, stops it when empty. Safe to call repeatedly.
func (f *Forwarder) SetDrains(parent context.Context, drains []protocol.DrainCfg) {
	f.apply(parent, drains)
}

// SetDrainsV2 applies the full drain set of a verified, capability-gated "log_drains_v2" frame. nil/empty stops
// every sink (also how a revoked `logs` capability takes effect).
func (f *Forwarder) SetDrainsV2(parent context.Context, drains []protocol.DrainCfg) {
	f.apply(parent, drains)
}

// apply reconciles the live sinks with a new drain set. An unchanged drain (same fingerprint) keeps its sink and
// connection; a changed one is rebuilt; a removed one is closed; one that cannot be built (unknown type, bad
// options, bad endpoint) is skipped and reported "invalid". An empty set stops everything.
func (f *Forwarder) apply(parent context.Context, drains []protocol.DrainCfg) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.parent = parent
	next := map[string]*sink{}
	invalid := map[string]string{}
	for _, cfg := range drains {
		if cfg.ID == "" {
			continue
		}
		fp := fingerprint(cfg)
		if old, ok := f.sinks[cfg.ID]; ok && old.fp == fp {
			next[cfg.ID] = old
			delete(f.sinks, cfg.ID)
			continue
		}
		sender, err := f.makeSender(cfg, f.serverID)
		if err != nil {
			logf("drain %s invalid: %s", cfg.ID, errConfig)
			invalid[cfg.ID] = errConfig
			continue
		}
		s := newSink(parent, cfg, sender, nil, f.notifyChange)
		s.start()
		next[cfg.ID] = s
	}
	for _, old := range f.sinks { // removed, changed or now-invalid
		old.close()
	}
	f.sinks, f.invalid = next, invalid

	if len(next) == 0 {
		f.stopTailsLocked()
	} else {
		f.startTailsLocked(parent)
	}
	if len(next) == 0 && len(invalid) == 0 {
		f.stopStatusLocked()
		return
	}
	f.startStatusLocked(parent)
	f.notifyChange()
}

// Stop tears down all tails, sinks and the status loop.
func (f *Forwarder) Stop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.sinks {
		s.close()
	}
	f.sinks, f.invalid = map[string]*sink{}, map[string]string{}
	f.stopTailsLocked()
	f.stopStatusLocked()
}

func (f *Forwarder) stopTailsLocked() {
	if f.tailCtx != nil {
		f.tailCtx()
		f.tailCtx = nil
	}
}

func (f *Forwarder) startTailsLocked(parent context.Context) {
	if f.tailCtx != nil || f.ps == nil { // already running (reconcile/dispatch read the latest sinks), or no docker hook (tests)
		return
	}
	ctx, cancel := context.WithCancel(parent)
	f.tailCtx = cancel
	batcher := NewBatcher(maxBatchBytes, maxBatchLines, flushInterval, f.dispatch)
	go batcher.Run(ctx)
	go f.reconcile(ctx, batcher)
}

// snapshot returns the live sinks.
func (f *Forwarder) snapshot() []*sink {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*sink, 0, len(f.sinks))
	for _, s := range f.sinks {
		out = append(out, s)
	}
	return out
}

// dispatch fans one batch out to every sink whose matcher wants each line. Non-blocking: each sink has its own
// bounded queue.
func (f *Forwarder) dispatch(lines []LogLine) {
	for _, s := range f.snapshot() {
		var sel []LogLine
		for _, l := range lines {
			if s.m.allows(l.Container) {
				sel = append(sel, l)
			}
		}
		if len(sel) > 0 {
			s.enqueue(sel)
		}
	}
}

// wants reports whether ANY sink wants a container's logs (a server with only app drains tails only those apps'
// containers).
func (f *Forwarder) wants(container string) bool {
	for _, s := range f.snapshot() {
		if s.m.allows(container) {
			return true
		}
	}
	return false
}
