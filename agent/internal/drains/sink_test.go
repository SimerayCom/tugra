package drains

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// fakeSender records batches; err/block let a test fail or wedge a sink.
type fakeSender struct {
	mu      sync.Mutex
	batches [][]LogLine
	err     error
	block   chan struct{} // when non-nil, Send waits for it (or ctx)
	closed  atomic.Bool
	calls   atomic.Int32
}

func (f *fakeSender) Send(ctx context.Context, lines []LogLine) error {
	f.calls.Add(1)
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.batches = append(f.batches, lines)
	return nil
}
func (f *fakeSender) Close() { f.closed.Store(true) }
func (f *fakeSender) got() [][]LogLine {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]LogLine(nil), f.batches...)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func batchOf(msg string) []LogLine { return []LogLine{{Container: "c", Message: msg}} }

func TestSinkQueueDropsOldest(t *testing.T) {
	s := newSink(context.Background(), protocol.DrainCfg{ID: "d"}, &fakeSender{}, nil, nil) // not started: the queue only fills
	for i := 0; i < queueBatches+6; i++ {
		s.enqueue([]LogLine{{Message: strings.Repeat("x", i%3+1)}, {Message: "y"}}) // 2 lines per batch
	}
	if len(s.q) != queueBatches {
		t.Fatalf("queue depth %d, want %d", len(s.q), queueBatches)
	}
	st := s.status()
	if st.Dropped != 12 || st.State != "error" || st.ErrClass != errOverflow { // 6 dropped batches x 2 lines
		t.Fatalf("status after overflow: %+v", st)
	}
	// the OLDEST batches went: the first one left is batch #6 (len(x) = 6%3+1 = 1)
	first := <-s.q
	if first[0].Message != "x" {
		t.Fatalf("oldest was not dropped first: %+v", first)
	}
}

func TestSinkBreakerOpensAndResets(t *testing.T) {
	now := time.Unix(1000, 0)
	fs := &fakeSender{err: errors.New("boom")}
	s := newSink(context.Background(), protocol.DrainCfg{ID: "d"}, fs, func() time.Time { return now }, nil)
	for i := 0; i < breakerThreshold; i++ {
		s.deliver(batchOf("a"))
	}
	if fs.calls.Load() != breakerThreshold {
		t.Fatalf("calls %d", fs.calls.Load())
	}
	s.deliver(batchOf("b")) // breaker open: not even tried, counted as dropped
	if fs.calls.Load() != breakerThreshold {
		t.Fatalf("a batch during cooldown must not be sent (calls %d)", fs.calls.Load())
	}
	st := s.status()
	if st.State != "error" || st.Dropped != 4 || st.ErrClass != errWrite {
		t.Fatalf("status in cooldown: %+v", st)
	}
	now = now.Add(9 * time.Second) // 2^3 = 8 s cooldown elapsed
	fs.mu.Lock()
	fs.err = nil
	fs.mu.Unlock()
	s.deliver(batchOf("c"))
	st = s.status()
	if fs.calls.Load() != breakerThreshold+1 || st.State != "ok" || st.ErrClass != "" || st.Sent != 1 || st.LastOkAt == 0 {
		t.Fatalf("after recovery: %+v calls %d", st, fs.calls.Load())
	}
	s.deliver(batchOf("d")) // closed again
	if fs.calls.Load() != breakerThreshold+2 {
		t.Fatal("success must close the breaker")
	}
}

func TestSinkCooldownCapsAtOneMinute(t *testing.T) {
	now := time.Unix(1000, 0)
	s := newSink(context.Background(), protocol.DrainCfg{ID: "d"}, &fakeSender{err: errors.New("x")}, func() time.Time { return now }, nil)
	s.failures = 20
	s.deliver(batchOf("a"))
	if d := s.cooldownUntil.Sub(now); d != maxCooldown {
		t.Fatalf("cooldown %v, want cap %v", d, maxCooldown)
	}
}

func TestSinkClassifiesErrors(t *testing.T) {
	s := newSink(context.Background(), protocol.DrainCfg{ID: "d"}, &fakeSender{err: &httpStatusErr{endpoint: "http://secret.example/x?token=zzz", code: 500}}, nil, nil)
	s.deliver(batchOf("a"))
	if st := s.status(); st.ErrClass != errHTTP {
		t.Fatalf("class %q", st.ErrClass)
	}
	// the class is all that is exposed: it never carries the endpoint
	if de := classifyErr(&httpStatusErr{endpoint: "http://secret.example", code: 500}); strings.Contains(de.Error(), "secret") {
		t.Fatalf("drainErr text leaks the endpoint: %s", de.Error())
	}
}

// withFakes swaps the package-level docker/sender hooks for one test.
func withFakes(t *testing.T, factory func(protocol.DrainCfg, string) (Sender, error)) {
	t.Helper()
	oldPs, oldTail, oldFactory := psFn, tailFn, senderFactory
	psFn = func(context.Context) []psEntry { return nil }
	tailFn = func(context.Context, string, time.Time, func(LogLine)) <-chan struct{} { return make(chan struct{}) }
	senderFactory = factory
	t.Cleanup(func() { psFn, tailFn, senderFactory = oldPs, oldTail, oldFactory })
}

func TestBlockedSinkDelaysNeitherDispatchNorOtherSinks(t *testing.T) {
	blocked := &fakeSender{block: make(chan struct{})}
	free := &fakeSender{}
	withFakes(t, func(cfg protocol.DrainCfg, _ string) (Sender, error) {
		if cfg.ID == "slow" {
			return blocked, nil
		}
		return free, nil
	})
	f := New("srv")
	defer f.Stop()
	f.SetDrainsV2(context.Background(), []protocol.DrainCfg{{ID: "slow", Type: "http"}, {ID: "fast", Type: "http"}})
	start := time.Now()
	for i := 0; i < 200; i++ { // far more batches than the blocked sink's queue holds
		f.dispatch(batchOf("line"))
	}
	if time.Since(start) > time.Second {
		t.Fatal("dispatch stalled behind a blocked sink")
	}
	waitFor(t, "fast sink to receive", func() bool { return len(free.got()) >= 1 })
	// the blocked sink dropped the overflow instead of stalling anything
	var slow *sink
	for _, s := range f.snapshot() {
		if s.cfg.ID == "slow" {
			slow = s
		}
	}
	if slow.status().Dropped == 0 {
		t.Fatal("blocked sink should have dropped overflow")
	}
	close(blocked.block)
}

func TestApplyKeepsRebuildsRemovesAndSkipsInvalid(t *testing.T) {
	var mu sync.Mutex
	var made []*fakeSender
	withFakes(t, func(cfg protocol.DrainCfg, id string) (Sender, error) {
		if cfg.Type == "bogus" {
			return nil, errors.New("unknown")
		}
		fs := &fakeSender{}
		mu.Lock()
		made = append(made, fs)
		mu.Unlock()
		return fs, nil
	})
	f := New("srv")
	defer f.Stop()
	ctx := context.Background()
	a := protocol.DrainCfg{ID: "a", Type: "http", Endpoint: "https://a", Token: "t1"}
	b := protocol.DrainCfg{ID: "b", Type: "loki", Endpoint: "https://b"}
	f.SetDrainsV2(ctx, []protocol.DrainCfg{a, b, {ID: "bad", Type: "bogus"}})
	if len(made) != 2 {
		t.Fatalf("senders built: %d", len(made))
	}
	sa := f.sinks["a"]
	st := f.Status()
	if len(st) != 3 || st[2].ID != "bad" || st[2].State != "invalid" || st[2].ErrClass != errConfig {
		t.Fatalf("status with an invalid drain: %+v", st)
	}

	// same fingerprint keeps the sink AND its sender (no rebuild, not closed)
	f.SetDrainsV2(ctx, []protocol.DrainCfg{a, b})
	if f.sinks["a"] != sa || len(made) != 2 || made[0].closed.Load() {
		t.Fatal("an unchanged drain must keep its sink and connection")
	}
	if len(f.invalid) != 0 {
		t.Fatal("the invalid drain is gone from the set")
	}

	// changed token = new fingerprint = rebuilt; old sender closed
	a2 := a
	a2.Token = "t2"
	f.SetDrainsV2(ctx, []protocol.DrainCfg{a2, b})
	if f.sinks["a"] == sa || !made[0].closed.Load() || len(made) != 3 {
		t.Fatal("a changed drain must be rebuilt and the old sender closed")
	}

	// removed = closed + deleted
	f.SetDrainsV2(ctx, []protocol.DrainCfg{a2})
	if _, ok := f.sinks["b"]; ok || !made[1].closed.Load() {
		t.Fatal("a removed drain must be closed and dropped")
	}

	// empty list stops everything
	f.SetDrainsV2(ctx, nil)
	if len(f.sinks) != 0 || f.tailCtx != nil {
		t.Fatal("an empty set must stop all sinks and the tails")
	}
}

func TestApplyUnknownTypeIsInvalidWithRealFactory(t *testing.T) {
	oldPs, oldTail := psFn, tailFn
	psFn = func(context.Context) []psEntry { return nil }
	tailFn = func(context.Context, string, time.Time, func(LogLine)) <-chan struct{} { return make(chan struct{}) }
	t.Cleanup(func() { psFn, tailFn = oldPs, oldTail })
	f := New("srv")
	defer f.Stop()
	f.SetDrainsV2(context.Background(), []protocol.DrainCfg{
		{ID: "x", Type: "carrier-pigeon", Endpoint: "h:1"},
		{ID: "y", Type: "syslog", Endpoint: "h:514"}, // options required
		{ID: "z", Type: "http", Endpoint: "ftp://h", Egress: "public"},
	})
	st := f.Status()
	if len(st) != 3 {
		t.Fatalf("status: %+v", st)
	}
	for _, s := range st {
		if s.State != "invalid" {
			t.Fatalf("%s should be invalid: %+v", s.ID, s)
		}
	}
}

func TestStatusReporterFiresOnChange(t *testing.T) {
	withFakes(t, func(protocol.DrainCfg, string) (Sender, error) { return &fakeSender{}, nil })
	got := make(chan protocol.DrainStatusMsg, 4)
	f := New("srv", WithStatusReporter(func(m protocol.DrainStatusMsg) { got <- m }))
	defer f.Stop()
	f.SetDrainsV2(context.Background(), []protocol.DrainCfg{{ID: "a", Type: "http"}})
	select {
	case m := <-got:
		if m.Type != "drain_status" || len(m.Drains) != 1 || m.Drains[0].ID != "a" || m.Drains[0].State != "idle" {
			t.Fatalf("status msg: %+v", m)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no status report after the drain set changed")
	}
}

func TestDispatchFiltersPerSinkMatcher(t *testing.T) {
	appSink, allSink := &fakeSender{}, &fakeSender{}
	withFakes(t, func(cfg protocol.DrainCfg, _ string) (Sender, error) {
		if cfg.ID == "app" {
			return appSink, nil
		}
		return allSink, nil
	})
	f := New("srv")
	defer f.Stop()
	f.SetDrainsV2(context.Background(), []protocol.DrainCfg{
		{ID: "app", Type: "http", Scope: "app", Match: resolveAppMatch("a1", nil)},
		{ID: "all", Type: "http"},
	})
	f.dispatch([]LogLine{{Container: "tugra_a1-web-1", Message: "mine"}, {Container: "tugra_b2", Message: "theirs"}, {Container: "tugra_db_x", Message: "db"}})
	waitFor(t, "both sinks", func() bool { return len(appSink.got()) == 1 && len(allSink.got()) == 1 })
	if g := appSink.got()[0]; len(g) != 1 || g[0].Message != "mine" {
		t.Fatalf("app sink got %+v", g)
	}
	if g := allSink.got()[0]; len(g) != 3 {
		t.Fatalf("server-wide sink got %+v", g)
	}
}
