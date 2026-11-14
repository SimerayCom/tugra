package journal

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBeginFinishDispositions(t *testing.T) {
	r := New("")
	d, _ := r.Begin("r1", "echo hi")
	if d != Fresh {
		t.Fatalf("first Begin: %v", d)
	}
	if d, _ := r.Begin("r1", "echo hi"); d != Running {
		t.Fatalf("duplicate while running: %v", d)
	}
	if _, d := r.Status("r1"); d != Running {
		t.Fatalf("Status while running: %v", d)
	}
	r.Chunk("r1", "hi\n")
	e := r.Finish("r1", 0, false)
	if e == nil || e.ExitCode != 0 || e.Output != "hi\n" || e.FinishedAt == 0 {
		t.Fatalf("Finish: %+v", e)
	}
	d, got := r.Begin("r1", "echo hi")
	if d != Done || got.Output != "hi\n" {
		t.Fatalf("duplicate after finish: %v %+v", d, got)
	}
	if _, d := r.Status("nope"); d != Unknown {
		t.Fatalf("Status unknown: %v", d)
	}
	if r.Finish("nope", 1, false) != nil {
		t.Fatal("Finish of an unknown reqId must be a no-op")
	}
}

func TestPersistReloadAndInterrupted(t *testing.T) {
	dir := t.TempDir()
	r := New(dir)
	r.Begin("running", "sleep 99")
	r.Begin("done", "echo x")
	r.Chunk("done", "x\n")
	r.Finish("done", 3, true)
	if _, err := os.Stat(filepath.Join(dir, "running.json")); err != nil {
		t.Fatalf("running entry must be persisted at Begin: %v", err)
	}
	// torn file → skipped and removed, never poisons the registry
	_ = os.WriteFile(filepath.Join(dir, "torn.json"), []byte(`{"reqId":"torn","sta`), 0o600)
	// stray tmp from a crash mid-write is ignored
	_ = os.WriteFile(filepath.Join(dir, "x.json.tmp"), []byte(`{}`), 0o600)

	r2 := New(dir) // "agent restart"
	e, d := r2.Status("running")
	if d != Interrupted || !e.Interrupted {
		t.Fatalf("a persisted running entry must load as interrupted: %v %+v", d, e)
	}
	if d, _ := r2.Begin("running", "sleep 99"); d != Interrupted {
		t.Fatalf("Begin of an interrupted entry: %v", d)
	}
	e, d = r2.Status("done")
	if d != Done || e.ExitCode != 3 || !e.Killed || e.Output != "x\n" {
		t.Fatalf("finished entry must reload intact: %v %+v", d, e)
	}
	if _, d := r2.Status("torn"); d != Unknown {
		t.Fatal("torn file must not load")
	}
	if _, err := os.Stat(filepath.Join(dir, "torn.json")); !os.IsNotExist(err) {
		t.Fatal("torn file must be removed")
	}
	st, _ := os.Stat(filepath.Join(dir, "done.json"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("journal files must be 0600: %v", st.Mode().Perm())
	}
}

func TestOutputKeeperHeadAndTail(t *testing.T) {
	r := New("")
	r.Begin("big", "build")
	head := strings.Repeat("H", headBytes)
	r.Chunk("big", head)
	r.Chunk("big", strings.Repeat("M", 200*1024)) // elided middle
	r.Chunk("big", strings.Repeat("T", tailBytes-20))
	r.Chunk("big", "TUGRA_DIGEST sha256:abc\n")
	e := r.Finish("big", 0, false)
	if !strings.HasPrefix(e.Output, head) {
		t.Fatal("head must be kept verbatim")
	}
	if !strings.HasSuffix(e.Output, "TUGRA_DIGEST sha256:abc\n") {
		t.Fatal("the END of the stream must survive (trailing markers)")
	}
	if !strings.Contains(e.Output, "bytes elided by the agent journal") {
		t.Fatal("elision must be marked")
	}
	if len(e.Output) > headBytes+tailBytes+128 {
		t.Fatalf("stored output must be bounded: %d", len(e.Output))
	}
	// small output: no marker, byte-exact
	r.Begin("small", "echo")
	r.Chunk("small", "a")
	r.Chunk("small", "b")
	if e := r.Finish("small", 0, false); e.Output != "ab" {
		t.Fatalf("small output: %q", e.Output)
	}
}

func TestPruneCapsFinishedNeverRunning(t *testing.T) {
	dir := t.TempDir()
	r := New(dir)
	now := time.Now()
	r.now = func() time.Time { return now }
	r.Begin("live", "sleep")
	for i := 0; i < maxEntries+10; i++ {
		id := "f" + itoa(i)
		now = now.Add(time.Millisecond)
		r.Begin(id, "x")
		r.Finish(id, 0, false)
	}
	if r.Len() != maxEntries+1 {
		t.Fatalf("expected %d entries (cap + the running one), got %d", maxEntries+1, r.Len())
	}
	if _, d := r.Status("live"); d != Running {
		t.Fatal("running entry must never be pruned")
	}
	if _, d := r.Status("f0"); d != Unknown {
		t.Fatal("oldest finished entries must be pruned first")
	}
	if _, err := os.Stat(filepath.Join(dir, "f0.json")); !os.IsNotExist(err) {
		t.Fatal("pruned entry file must be removed")
	}
	// age cap
	now = now.Add(maxAge + time.Hour)
	r.Begin("fresh", "x")
	r.Finish("fresh", 0, false)
	if _, d := r.Status("f70"); d != Unknown {
		t.Fatal("entries older than maxAge must be pruned")
	}
	if _, d := r.Status("live"); d != Running {
		t.Fatal("running entry survives the age cap too")
	}
}

func TestCancelTrackingAndSink(t *testing.T) {
	r := New("")
	ctx, cancel := context.WithCancel(context.Background())
	r.Track("c1", cancel)
	if !r.Cancel("c1") {
		t.Fatal("tracked command must be cancellable")
	}
	if ctx.Err() == nil {
		t.Fatal("cancel func must have fired")
	}
	r.Untrack("c1")
	if r.Cancel("c1") {
		t.Fatal("untracked command is not cancellable")
	}
	if r.Cancel("never") {
		t.Fatal("unknown reqId is not cancellable")
	}
	if err := r.Send("x"); err == nil {
		t.Fatal("no sink → error (dropped)")
	}
	var got []any
	r.SetSink(func(v any) error { got = append(got, v); return nil })
	_ = r.Send("a")
	r.ClearSink()
	_ = r.Send("b")
	if len(got) != 1 || got[0] != "a" {
		t.Fatalf("sink routing: %v", got)
	}
}

func TestSafeName(t *testing.T) {
	if SafeName("dep-abc_123") != "dep-abc_123" {
		t.Fatal("plain ids are used verbatim")
	}
	for _, bad := range []string{"../../etc/passwd", "a/b", "", strings.Repeat("x", 200), "a b"} {
		n := SafeName(bad)
		if !strings.HasPrefix(n, "h_") || strings.ContainsAny(n, "/\\. ") {
			t.Fatalf("unsafe id must be hashed: %q -> %q", bad, n)
		}
	}
}
