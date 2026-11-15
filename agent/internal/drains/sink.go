package drains

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	// queueBatches is the per-sink queue depth (in BATCHES). A full queue drops the OLDEST batch, so a slow
	// or dead sink can never block the tails or another sink.
	queueBatches = 64
	// breakerThreshold consecutive failed batches open the circuit breaker.
	breakerThreshold = 3
	maxCooldown      = 60 * time.Second
	dropLogInterval  = 60 * time.Second
)

// logf writes an operator-visible stderr line. Callers pass ONLY drain ids and error classes: never an
// endpoint, a token or raw error text.
var logf = func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }

// Sender delivers one batch to one external sink. Implementations own their connection and must be safe to Close
// while a Send is in flight (Close makes the Send fail promptly).
type Sender interface {
	Send(ctx context.Context, lines []LogLine) error
	Close()
}

// senderFactory is overridable so tests can inject fake senders into Forwarder.apply.
var senderFactory = newSender

// defaultHTTPClient is the shared client of legacy (unguarded) http/loki/datadog sinks: exactly today's client.
var defaultHTTPClient = &http.Client{Timeout: 10 * time.Second}

type sink struct {
	cfg    protocol.DrainCfg
	fp     string
	m      matcher
	sender Sender
	q      chan []LogLine
	now    func() time.Time
	notify func() // state-change hook (status debounce); may be nil

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}

	mu            sync.Mutex
	sent          int64
	dropped       int64
	state         string // idle | ok | error
	errClass      string
	lastOK        time.Time
	failures      int
	cooldownUntil time.Time
	loggedDropped int64
}

func newSink(parent context.Context, cfg protocol.DrainCfg, sender Sender, now func() time.Time, notify func()) *sink {
	ctx, cancel := context.WithCancel(parent)
	if now == nil {
		now = time.Now
	}
	return &sink{
		cfg: cfg, fp: fingerprint(cfg), m: compileMatcher(cfg), sender: sender,
		q: make(chan []LogLine, queueBatches), now: now, notify: notify,
		ctx: ctx, cancel: cancel, done: make(chan struct{}), state: "idle",
	}
}

// fingerprint identifies a drain's full effective config (token included) so an unchanged drain keeps its sink and
// connection across re-pushes. Hash only: it is never logged.
func fingerprint(cfg protocol.DrainCfg) string {
	b, _ := json.Marshal(cfg)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// start launches the sink's delivery goroutine.
func (s *sink) start() { go s.run() }

func (s *sink) run() {
	defer close(s.done)
	t := time.NewTicker(dropLogInterval)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case b := <-s.q:
			s.deliver(b)
		case <-t.C:
			s.logDrops()
		}
	}
}

// enqueue is non-blocking: a full queue drops the OLDEST batch (counted) to make room for the newest.
func (s *sink) enqueue(lines []LogLine) {
	if len(lines) == 0 {
		return
	}
	for {
		select {
		case s.q <- lines:
			return
		default:
		}
		select {
		case old := <-s.q:
			s.addDropped(len(old), errOverflow)
		default:
		}
	}
}

func (s *sink) addDropped(n int, class string) {
	s.mu.Lock()
	s.dropped += int64(n)
	changed := false
	if class != "" && s.state != "error" {
		s.state, s.errClass = "error", class
		changed = true
	}
	s.mu.Unlock()
	if changed {
		s.changed()
	}
}

func (s *sink) changed() {
	if s.notify != nil {
		s.notify()
	}
}

// deliver sends one batch through the circuit breaker: 3 consecutive failed batches open it for
// min(2^n s, 60 s), during which batches are dropped (counted) instead of tried; one success closes it.
func (s *sink) deliver(batch []LogLine) {
	now := s.now()
	s.mu.Lock()
	cooling := now.Before(s.cooldownUntil)
	s.mu.Unlock()
	if cooling {
		s.addDropped(len(batch), "")
		return
	}
	err := s.sender.Send(s.ctx, batch)
	s.mu.Lock()
	prevState, prevClass := s.state, s.errClass
	if err == nil {
		s.sent += int64(len(batch))
		s.state, s.errClass = "ok", ""
		s.lastOK = now
		s.failures = 0
		s.cooldownUntil = time.Time{}
	} else {
		de := classifyErr(err)
		s.dropped += int64(len(batch)) // a failed batch is not retried again later
		s.state, s.errClass = "error", de.class
		s.failures++
		if s.failures >= breakerThreshold {
			shift := s.failures
			if shift > 6 {
				shift = 6
			}
			cd := time.Duration(1<<uint(shift)) * time.Second
			if cd > maxCooldown {
				cd = maxCooldown
			}
			s.cooldownUntil = now.Add(cd)
		}
	}
	changed := prevState != s.state || prevClass != s.errClass
	s.mu.Unlock()
	if changed {
		s.changed()
	}
}

func (s *sink) logDrops() {
	s.mu.Lock()
	d, class := s.dropped, s.errClass
	delta := d - s.loggedDropped
	s.loggedDropped = d
	s.mu.Unlock()
	if delta > 0 {
		if class == "" {
			class = "unknown"
		}
		logf("drain %s dropped %d lines (%s)", s.cfg.ID, delta, class)
	}
}

func (s *sink) status() protocol.DrainStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := protocol.DrainStatus{ID: s.cfg.ID, State: s.state, ErrClass: s.errClass, Sent: s.sent, Dropped: s.dropped}
	if !s.lastOK.IsZero() {
		st.LastOkAt = s.lastOK.UnixMilli()
	}
	return st
}

// close stops the delivery goroutine and tears the sender's connection down (never blocks on an in-flight send).
func (s *sink) close() {
	s.cancel()
	s.sender.Close()
}

// ---- senders ----

// newSender builds the Sender for one drain. An unknown type, bad options or a malformed endpoint is an error
// (the drain is skipped and reported "invalid").
func newSender(cfg protocol.DrainCfg, serverID string) (Sender, error) {
	switch cfg.Egress {
	case "", egressPublic, egressAny:
	default:
		return nil, fmt.Errorf("unknown egress policy")
	}
	switch strings.ToLower(cfg.Type) {
	case "", "http", "loki", "datadog":
		return newHTTPSender(cfg, serverID)
	case "syslog":
		return newSyslogSender(cfg)
	case "gelf":
		return newGelfSender(cfg)
	case "fluentd":
		return newFluentSender(cfg)
	default:
		return nil, fmt.Errorf("unknown drain type")
	}
}

type httpSender struct {
	client   *http.Client
	serverID string
	cfg      protocol.DrainCfg
	tr       *http.Transport
}

func newHTTPSender(cfg protocol.DrainCfg, serverID string) (Sender, error) {
	if cfg.Egress == "" { // legacy server-wide drain: unguarded, exactly as before
		return &httpSender{client: defaultHTTPClient, serverID: serverID, cfg: cfg}, nil
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("bad http endpoint")
	}
	tr := guardedTransport(cfg.Egress)
	return &httpSender{client: &http.Client{Timeout: 10 * time.Second, Transport: tr}, serverID: serverID, cfg: cfg, tr: tr}, nil
}

func (h *httpSender) Send(_ context.Context, lines []LogLine) error {
	return postBatch(h.client, h.serverID, h.cfg, lines)
}

func (h *httpSender) Close() {
	if h.tr != nil {
		h.tr.CloseIdleConnections()
	}
}
