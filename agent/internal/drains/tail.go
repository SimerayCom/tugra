package drains

import (
	"bufio"
	"context"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// maxLineBytes caps one log line (parity with the previous bufio.Scanner limit). A longer line is truncated and
// the rest discarded up to the newline; it never kills the tail.
const maxLineBytes = 1024 * 1024

const truncatedMarker = "…[truncated]"

// readLineCapped reads one line (without the trailing \n / \r\n), keeping at most max bytes. When the line is
// longer, the excess is discarded up to the newline and truncatedMarker is appended, so the reader stays in sync
// and the tail continues. At EOF a final unterminated line is returned first, then io.EOF.
func readLineCapped(r *bufio.Reader, max int) (string, error) {
	var buf []byte
	truncated := false
	for {
		chunk, err := r.ReadSlice('\n')
		hasNL := false
		data := chunk
		if n := len(data); n > 0 && data[n-1] == '\n' {
			data, hasNL = data[:n-1], true
		}
		if !truncated && len(data) > 0 {
			room := max - len(buf)
			if len(data) <= room {
				buf = append(buf, data...)
			} else {
				if room > 0 {
					buf = append(buf, data[:room]...)
				}
				truncated = true
			}
		}
		if hasNL {
			break
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			if len(buf) == 0 && !truncated {
				return "", err
			}
			break
		}
	}
	if n := len(buf); n > 0 && buf[n-1] == '\r' {
		buf = buf[:n-1]
	}
	s := string(buf)
	if truncated {
		s += truncatedMarker
	}
	return s, nil
}

// splitDockerTS strips the leading RFC3339Nano token that `docker logs -t` prepends. On a parse failure the
// message is returned untouched with a zero time.
func splitDockerTS(line string) (time.Time, string) {
	i := strings.IndexByte(line, ' ')
	if i <= 0 {
		return time.Time{}, line
	}
	ts, err := time.Parse(time.RFC3339Nano, line[:i])
	if err != nil {
		return time.Time{}, line
	}
	return ts, line[i+1:]
}

// pumpLines reads capped lines from r and emits them tagged with stream until EOF.
func pumpLines(r io.Reader, stream string, emit func(LogLine)) {
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := readLineCapped(br, maxLineBytes)
		if err != nil {
			return
		}
		ts, msg := splitDockerTS(line)
		emit(LogLine{Message: msg, TS: ts, Stream: stream})
	}
}

// psEntry is one running container.
type psEntry struct{ ID, Name string }

// psFn and tailFn are injectable so reconcile is unit-tested without docker.
var (
	psFn   = dockerPs
	tailFn = tailContainer
)

// dockerPs lists running tugra_ containers as ID + current name (best-effort, empty on error).
func dockerPs(ctx context.Context) []psEntry {
	out, err := exec.CommandContext(ctx, "docker", "ps", "--format", "{{.ID}} {{.Names}}", "--filter", "name=tugra_").Output()
	if err != nil {
		return nil
	}
	return parsePs(string(out))
}

func parsePs(out string) []psEntry {
	var res []psEntry
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		name := f[1]
		if i := strings.IndexByte(name, ','); i >= 0 { // a container with several names: use the first
			name = name[:i]
		}
		res = append(res, psEntry{ID: f[0], Name: name})
	}
	return res
}

// tailContainer streams `docker logs -f -t` of one container (by ID) into emit until ctx ends or the process
// exits. A zero `since` starts at "now" (--tail 0); otherwise it resumes from `since` (--since RFC3339Nano).
// stdout and stderr are read as two pipes so each line carries its stream. The returned channel closes when the
// tail has ended (so reconcile can restart it if the container is still running).
func tailContainer(ctx context.Context, id string, since time.Time, emit func(LogLine)) <-chan struct{} {
	done := make(chan struct{})
	args := []string{"logs", "-f", "-t"}
	if since.IsZero() {
		args = append(args, "--tail", "0")
	} else {
		args = append(args, "--since", since.UTC().Format(time.RFC3339Nano))
	}
	args = append(args, id)
	cmd := exec.CommandContext(ctx, "docker", args...)
	stdout, err1 := cmd.StdoutPipe()
	stderr, err2 := cmd.StderrPipe()
	if err1 != nil || err2 != nil || cmd.Start() != nil {
		close(done)
		return done
	}
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); pumpLines(stdout, "stdout", emit) }()
		go func() { defer wg.Done(); pumpLines(stderr, "stderr", emit) }()
		wg.Wait()
		_ = cmd.Wait()
	}()
	return done
}

// tailState is one running tail, keyed by container ID. The container name is refreshed every tick and read at
// emit time, so a rolling-deploy `docker rename` keeps ONE tail (no gap, no duplicate) and the matcher sees the
// new name.
type tailState struct {
	cancel    context.CancelFunc
	done      <-chan struct{}
	name      atomic.Value // string
	lastTS    atomic.Int64 // unix nano of the last emitted line (0 = none)
	started   time.Time
	restarted atomic.Bool
}

// reconciler keeps one `docker logs -f` tail per running container that ANY sink wants, keyed by container ID.
type reconciler struct {
	f     *Forwarder
	ctx   context.Context
	b     *Batcher
	tails map[string]*tailState
}

func newReconciler(f *Forwarder, ctx context.Context, b *Batcher) *reconciler {
	return &reconciler{f: f, ctx: ctx, b: b, tails: map[string]*tailState{}}
}

func (r *reconciler) start(id, name string, since time.Time, lastTS int64, started time.Time) *tailState {
	tctx, cancel := context.WithCancel(r.ctx)
	st := &tailState{cancel: cancel, started: started}
	st.name.Store(name)
	st.lastTS.Store(lastTS)
	st.restarted.Store(!since.IsZero())
	emit := func(l LogLine) {
		if !l.TS.IsZero() {
			n := l.TS.UnixNano()
			// After a restart docker re-sends the boundary line (--since is inclusive): skip anything not
			// newer than what was already emitted (best-effort at-least-once, boundary duplicates possible).
			if st.restarted.Load() && n <= st.lastTS.Load() {
				return
			}
			st.lastTS.Store(n)
		}
		l.Container = st.name.Load().(string)
		r.b.Add(l)
	}
	st.done = r.f.tail(tctx, id, since, emit)
	return st
}

// tick is one reconcile pass: start tails for newly wanted containers, refresh names, restart tails that ended
// while their container still runs (resuming with --since, never `--tail 0` again), cancel vanished/unwanted ones.
func (r *reconciler) tick() {
	seen := map[string]bool{}
	for _, e := range r.f.ps(r.ctx) {
		if !r.f.wants(e.Name) {
			continue
		}
		seen[e.ID] = true
		st, ok := r.tails[e.ID]
		if !ok {
			r.tails[e.ID] = r.start(e.ID, e.Name, time.Time{}, 0, time.Now())
			continue
		}
		st.name.Store(e.Name)
		select {
		case <-st.done:
			st.cancel()
			last := st.lastTS.Load()
			since := time.Unix(0, last)
			if last == 0 {
				since = st.started
			}
			r.tails[e.ID] = r.start(e.ID, e.Name, since, last, st.started)
		default:
		}
	}
	for id, st := range r.tails {
		if !seen[id] {
			st.cancel()
			delete(r.tails, id)
		}
	}
}

func (r *reconciler) stop() {
	for _, t := range r.tails {
		t.cancel()
	}
}

// reconcile runs the reconciler until ctx ends.
func (f *Forwarder) reconcile(ctx context.Context, b *Batcher) {
	r := newReconciler(f, ctx, b)
	defer r.stop()
	r.tick()
	t := time.NewTicker(reconcileInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.tick()
		}
	}
}
