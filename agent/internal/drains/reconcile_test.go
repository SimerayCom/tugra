package drains

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

type tailCall struct {
	id    string
	since time.Time
	emit  func(LogLine)
	done  chan struct{}
	ctx   context.Context
}

type recon struct {
	f     *Forwarder
	r     *reconciler
	mu    sync.Mutex
	calls []*tailCall
	ps    []psEntry
	out   []LogLine
	b     *Batcher
}

// newRecon builds a reconciler with drains that want containers, fake ps/tail hooks and a batcher whose output
// is collected (flushed by the test).
func newRecon(t *testing.T, cfgs ...protocol.DrainCfg) *recon {
	t.Helper()
	rc := &recon{}
	withFakes(t, func(protocol.DrainCfg, string) (Sender, error) { return &fakeSender{}, nil })
	psFn, tailFn = nil, nil // the forwarder's own tail loop must NOT start: the test drives the reconciler by hand
	rc.f = New("srv")
	t.Cleanup(rc.f.Stop)
	if len(cfgs) == 0 {
		cfgs = []protocol.DrainCfg{{ID: "all", Type: "http"}}
	}
	rc.f.SetDrainsV2(context.Background(), cfgs)
	rc.f.ps = func(context.Context) []psEntry {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		return append([]psEntry(nil), rc.ps...)
	}
	rc.f.tail = func(ctx context.Context, id string, since time.Time, emit func(LogLine)) <-chan struct{} {
		c := &tailCall{id: id, since: since, emit: emit, done: make(chan struct{}), ctx: ctx}
		rc.mu.Lock()
		rc.calls = append(rc.calls, c)
		rc.mu.Unlock()
		return c.done
	}
	rc.b = NewBatcher(1<<20, 0, time.Hour, func(l []LogLine) { rc.mu.Lock(); rc.out = append(rc.out, l...); rc.mu.Unlock() })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	rc.r = newReconciler(rc.f, ctx, rc.b)
	return rc
}

func (rc *recon) setPs(e ...psEntry) { rc.mu.Lock(); rc.ps = e; rc.mu.Unlock() }
func (rc *recon) callCount() int     { rc.mu.Lock(); defer rc.mu.Unlock(); return len(rc.calls) }
func (rc *recon) lastCall() *tailCall {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.calls[len(rc.calls)-1]
}
func (rc *recon) flushed() []LogLine {
	rc.b.Flush()
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return append([]LogLine(nil), rc.out...)
}

func TestReconcileRestartsEndedTailWithSince(t *testing.T) {
	rc := newRecon(t)
	rc.setPs(psEntry{"id1", "tugra_a"})
	rc.r.tick()
	first := rc.lastCall()
	if !first.since.IsZero() {
		t.Fatal("the first tail starts at 'now' (--tail 0 => zero since)")
	}
	ts := time.Date(2026, 11, 15, 10, 0, 5, 777, time.UTC)
	first.emit(LogLine{Message: "one", TS: ts})
	rc.r.tick() // still running: no restart
	if rc.callCount() != 1 {
		t.Fatal("a live tail must not be restarted")
	}
	close(first.done) // `docker logs -f` exited while the container keeps running (quick restart)
	rc.r.tick()
	if rc.callCount() != 2 {
		t.Fatalf("an ended tail of a still-running container must restart, calls=%d", rc.callCount())
	}
	second := rc.lastCall()
	if !second.since.Equal(ts) {
		t.Fatalf("restart must resume from the last emitted TS, got %v", second.since)
	}
	// boundary: docker re-sends the line at exactly `since` -> skipped; a newer line passes
	second.emit(LogLine{Message: "one-again", TS: ts})
	second.emit(LogLine{Message: "two", TS: ts.Add(time.Second)})
	var msgs []string
	for _, l := range rc.flushed() {
		msgs = append(msgs, l.Message)
	}
	if len(msgs) != 2 || msgs[0] != "one" || msgs[1] != "two" {
		t.Fatalf("emitted %v, want [one two] (boundary duplicate skipped)", msgs)
	}
}

func TestReconcileRestartWithoutLinesUsesTailStart(t *testing.T) {
	rc := newRecon(t)
	rc.setPs(psEntry{"id1", "tugra_a"})
	rc.r.tick()
	close(rc.lastCall().done)
	rc.r.tick()
	if rc.lastCall().since.IsZero() {
		t.Fatal("a restart must never fall back to `--tail 0` again")
	}
}

func TestReconcileRenameKeepsOneTailAndUpdatesName(t *testing.T) {
	rc := newRecon(t)
	rc.setPs(psEntry{"id1", "tugra_a__rollout"})
	rc.r.tick()
	c := rc.lastCall()
	c.emit(LogLine{Message: "before"})
	rc.setPs(psEntry{"id1", "tugra_a"}) // rolling deploy: docker rename, same ID
	rc.r.tick()
	if rc.callCount() != 1 {
		t.Fatal("a rename must keep the one tail (no gap, no duplicate)")
	}
	c.emit(LogLine{Message: "after"})
	out := rc.flushed()
	if len(out) != 2 || out[0].Container != "tugra_a__rollout" || out[1].Container != "tugra_a" {
		t.Fatalf("emitted names: %+v", out)
	}
}

func TestReconcileTailsOnlyWantedAndCancelsVanished(t *testing.T) {
	app := protocol.DrainCfg{ID: "app", Type: "http", Scope: "app", Match: resolveAppMatch("a1", nil)}
	rc := newRecon(t, app)
	rc.setPs(psEntry{"id1", "tugra_a1"}, psEntry{"id2", "tugra_other"}, psEntry{"id3", "tugra_db_x"})
	rc.r.tick()
	if rc.callCount() != 1 || rc.lastCall().id != "id1" {
		t.Fatalf("only the app's container may be tailed, calls=%d", rc.callCount())
	}
	c := rc.lastCall()
	rc.setPs() // container vanished
	rc.r.tick()
	select {
	case <-c.ctx.Done():
	default:
		t.Fatal("the tail of a vanished container must be cancelled")
	}
	if len(rc.r.tails) != 0 {
		t.Fatal("vanished tail must be forgotten")
	}
}
