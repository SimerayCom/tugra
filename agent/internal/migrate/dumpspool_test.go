package migrate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ---- helpers ------------------------------------------------------------------------------------------------------------

// dirBytes is the total size and file count of the regular files under dir.
func dirBytes(dir string) (total int64, files int) {
	_ = filepath.Walk(dir, func(_ string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			total += fi.Size()
			files++
		}
		return nil
	})
	return
}

func eventually(t *testing.T, what string, d time.Duration, f func() bool) {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if f() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// genReader serves `total` pseudo-random bytes without keeping them, hashing what it served.
type genReader struct {
	remaining int64
	x         uint32
	sum       interface {
		Write([]byte) (int, error)
		Sum([]byte) []byte
	}
	closed atomic.Bool
}

func newGenReader(total int64) *genReader {
	return &genReader{remaining: total, x: 2463534242, sum: sha256.New()}
}

func (g *genReader) Read(p []byte) (int, error) {
	if g.closed.Load() {
		return 0, io.ErrClosedPipe
	}
	if g.remaining <= 0 {
		return 0, io.EOF
	}
	if int64(len(p)) > g.remaining {
		p = p[:g.remaining]
	}
	for i := range p {
		g.x ^= g.x << 13
		g.x ^= g.x >> 17
		g.x ^= g.x << 5
		p[i] = byte(g.x)
	}
	g.remaining -= int64(len(p))
	g.sum.Write(p)
	return len(p), nil
}

func (g *genReader) Close() error { g.closed.Store(true); return nil }

func spoolFor(t *testing.T, src io.ReadCloser, o DumpSpoolOpts) (*dumpSpool, string) {
	t.Helper()
	root := t.TempDir()
	o.Dir = root
	if o.Poll == 0 {
		o.Poll = 5 * time.Millisecond
	}
	s, err := newDumpSpool(context.Background(), src, o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, root
}

func noMargin(string) (uint64, bool) { return 1 << 50, true }

// ---- the spool on its own -----------------------------------------------------------------------------------------------

func TestSpoolRoundTripAcrossSegmentBoundaries(t *testing.T) {
	for _, size := range []int{1, 999, 1000, 1001, 2500, 5000, 5001, 300000} {
		data := streamBytes(size)
		s, root := spoolFor(t, io.NopCloser(bytes.NewReader(data)), DumpSpoolOpts{SegBytes: 1000, Free: noMargin})
		got, err := io.ReadAll(s)
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("size %d: equal=%v err=%v", size, bytes.Equal(got, data), err)
		}
		// every consumed segment is gone at once: nothing is left on disk once the stream was read to EOF
		if total, files := dirBytes(root); total != 0 || files != 0 {
			t.Errorf("size %d: %d files / %d bytes left after a full read", size, files, total)
		}
		s.Close()
		if entries, _ := os.ReadDir(root); len(entries) != 0 {
			t.Errorf("size %d: Close left the spool directory behind: %v", size, entries)
		}
	}
}

func TestSpoolEmptyStreamIsEOF(t *testing.T) {
	s, _ := spoolFor(t, io.NopCloser(bytes.NewReader(nil)), DumpSpoolOpts{Free: noMargin})
	if n, err := s.Read(make([]byte, 8)); n != 0 || err != io.EOF {
		t.Errorf("empty stream: n=%d err=%v", n, err)
	}
}

// The drain runs ahead of a reader that is not reading, and stops at the cap (the client then blocks again, as before). The
// pause is logged exactly once.
func TestSpoolCapPausesTheDrainAndResumesWhenRead(t *testing.T) {
	pr, pw := io.Pipe()
	var logs atomic.Int32
	var logged strings.Builder
	var lmu sync.Mutex
	logf := func(f string, a ...any) {
		logs.Add(1)
		lmu.Lock()
		logged.WriteString(f)
		lmu.Unlock()
	}
	s, root := spoolFor(t, pr, DumpSpoolOpts{SegBytes: 1000, CapBytes: 4000, Free: noMargin, Logf: logf})

	const writes, each = 40, 500 // 20000 bytes in 500-byte writes
	var done atomic.Int32
	go func() {
		for i := 0; i < writes; i++ {
			if _, err := pw.Write(bytes.Repeat([]byte{byte(i)}, each)); err != nil {
				return
			}
			done.Add(1)
		}
		pw.Close()
	}()

	// the drain takes the cap (8 writes) plus the one chunk it holds, and then the client is blocked
	eventually(t, "the drain to pause", 5*time.Second, func() bool { return logs.Load() == 1 })
	time.Sleep(100 * time.Millisecond)
	if d := done.Load(); d > 10 {
		t.Errorf("the client completed %d of %d writes with nobody reading: the drain did not stop at the cap", d, writes)
	}
	if total, _ := dirBytes(root); total > 4000 {
		t.Errorf("%d bytes on disk with a 4000 byte cap", total)
	}

	got, err := io.ReadAll(s)
	if err != nil || len(got) != writes*each {
		t.Fatalf("read %d bytes, err %v", len(got), err)
	}
	for i := 0; i < writes; i++ {
		if got[i*each] != byte(i) || got[(i+1)*each-1] != byte(i) {
			t.Fatalf("the stream is out of order at write %d", i)
		}
	}
	if logs.Load() != 1 {
		t.Errorf("the pause was logged %d times, want once", logs.Load())
	}
	lmu.Lock()
	defer lmu.Unlock()
	if !strings.Contains(logged.String(), "dump spool") {
		t.Errorf("log line: %q", logged.String())
	}
	if p := s.PeakBacklog(); p <= 0 || p > 4000 {
		t.Errorf("peak backlog %d, want within (0, 4000]", p)
	}
}

// The free space of the spool directory (minus the margin) limits the backlog like the cap does.
func TestSpoolFreeSpaceMarginPausesTheDrain(t *testing.T) {
	var free atomic.Int64
	free.Store(1 << 40)
	pr, pw := io.Pipe()
	var logs atomic.Int32
	s, _ := spoolFor(t, pr, DumpSpoolOpts{SegBytes: 1000, MarginBytes: 1000, Free: func(string) (uint64, bool) { return uint64(free.Load()), true },
		Logf: func(string, ...any) { logs.Add(1) }})
	var done atomic.Int32
	go func() {
		for i := 0; i < 20; i++ {
			if _, err := pw.Write(make([]byte, 500)); err != nil {
				return
			}
			done.Add(1)
		}
		pw.Close()
	}()
	eventually(t, "some bytes to be spooled", 5*time.Second, func() bool { return done.Load() >= 4 })
	free.Store(1200) // only 200 bytes above the margin: with a backlog on disk, a 500 byte chunk no longer fits
	eventually(t, "the drain to pause on free space", 5*time.Second, func() bool { return logs.Load() == 1 })
	paused := done.Load()
	time.Sleep(100 * time.Millisecond)
	if d := done.Load(); d > paused+1 {
		t.Errorf("the client kept writing (%d -> %d) with the spool directory out of room", paused, d)
	}
	free.Store(1 << 40) // room again
	got, err := io.ReadAll(s)
	if err != nil || len(got) != 20*500 {
		t.Fatalf("read %d bytes, err %v", len(got), err)
	}
}

// With nothing on disk one chunk always goes through, so a spool directory with no room degrades to the old behaviour instead of
// deadlocking.
func TestSpoolWithNoRoomAtAllStillDeliversTheStream(t *testing.T) {
	data := streamBytes(50000)
	s, _ := spoolFor(t, io.NopCloser(bytes.NewReader(data)), DumpSpoolOpts{SegBytes: 1000, CapBytes: 1000, MarginBytes: 1 << 40, Free: func(string) (uint64, bool) { return 0, true }})
	got, err := io.ReadAll(s)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("equal=%v err=%v", bytes.Equal(got, data), err)
	}
}

// Disk use follows the backlog: a fast client and a slow reader never put more than the cap on disk, consumed segments are deleted
// while the dump is still running, and the whole dump never exists on disk.
func TestSpoolDiskUseStaysAtTheBacklogAndSegmentsAreDeletedAsRead(t *testing.T) {
	const total, seg, capB = 3 << 20, 64 << 10, 256 << 10
	g := newGenReader(total)
	s, root := spoolFor(t, g, DumpSpoolOpts{SegBytes: seg, CapBytes: capB, Free: noMargin})
	buf := make([]byte, 16<<10)
	var read, maxDisk int64
	maxFiles := 0
	h := sha256.New()
	for {
		n, err := s.Read(buf)
		h.Write(buf[:n])
		read += int64(n)
		if d, f := dirBytes(root); d > maxDisk {
			maxDisk = d
			if f > maxFiles {
				maxFiles = f
			}
		}
		if n > 0 && read%(256<<10) < int64(n) {
			time.Sleep(15 * time.Millisecond) // a slow uploader: the drain gets ahead
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if read != total || !bytes.Equal(h.Sum(nil), g.sum.Sum(nil)) {
		t.Fatalf("read %d of %d bytes, hash equal=%v", read, total, bytes.Equal(h.Sum(nil), g.sum.Sum(nil)))
	}
	if maxDisk > capB {
		t.Errorf("up to %d bytes on disk with a %d byte cap", maxDisk, capB)
	}
	if maxDisk >= total/2 {
		t.Errorf("%d of %d bytes on disk: consumed segments are not deleted", maxDisk, total)
	}
	if maxFiles > capB/seg+1 {
		t.Errorf("up to %d segment files live at once, want at most %d", maxFiles, capB/seg+1)
	}
	if p := s.PeakBacklog(); p <= 0 || p > capB {
		t.Errorf("peak backlog %d, want within (0, %d]", p, capB)
	}
}

// A large dump flows through with a flat Go heap: the spool holds one chunk, never a segment or the dump.
func TestSpoolMemoryStaysBoundedForALargeDump(t *testing.T) {
	if testing.Short() {
		t.Skip("streams 192 MiB")
	}
	const total = 192 << 20
	g := newGenReader(total)
	s, root := spoolFor(t, g, DumpSpoolOpts{SegBytes: 8 << 20, CapBytes: 64 << 20, Free: noMargin})

	runtime.GC()
	var base runtime.MemStats
	runtime.ReadMemStats(&base)
	var peak atomic.Uint64
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		var m runtime.MemStats
		for {
			select {
			case <-stop:
				return
			case <-time.After(5 * time.Millisecond):
			}
			runtime.ReadMemStats(&m)
			if m.HeapInuse > peak.Load() {
				peak.Store(m.HeapInuse)
			}
		}
	}()
	h := sha256.New()
	n, err := io.CopyBuffer(h, s, make([]byte, 1<<20))
	close(stop)
	wg.Wait()
	if err != nil || n != total || !bytes.Equal(h.Sum(nil), g.sum.Sum(nil)) {
		t.Fatalf("copied %d of %d, err %v, hash equal=%v", n, int64(total), err, bytes.Equal(h.Sum(nil), g.sum.Sum(nil)))
	}
	if grew := int64(peak.Load()) - int64(base.HeapInuse); grew > 40<<20 {
		t.Errorf("the Go heap grew by %d MiB while a %d MiB dump went through the spool", grew>>20, total>>20)
	}
	if total, _ := dirBytes(root); total != 0 {
		t.Errorf("%d bytes left on disk", total)
	}
}

func TestSpoolSourceErrorPropagatesAndCloseCleansUp(t *testing.T) {
	boom := errors.New("connection reset")
	pr, pw := io.Pipe()
	s, root := spoolFor(t, pr, DumpSpoolOpts{SegBytes: 1000, Free: noMargin})
	go func() { pw.Write(make([]byte, 100)); pw.CloseWithError(boom) }()
	_, err := io.ReadAll(s)
	if !errors.Is(err, boom) {
		t.Fatalf("a failing stream must surface its error: %v", err)
	}
	s.Close()
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

func TestSpoolWriteErrorPropagates(t *testing.T) {
	pr, pw := io.Pipe()
	s, root := spoolFor(t, pr, DumpSpoolOpts{SegBytes: 1000, Free: noMargin})
	// the spool directory vanishes under the drain (the portable stand-in for a full or failing disk: creating a segment fails)
	if err := os.RemoveAll(s.dir); err != nil {
		t.Fatal(err)
	}
	go func() { pw.Write(make([]byte, 100)); pw.Close() }()
	_, err := io.ReadAll(s)
	if err == nil || !strings.Contains(err.Error(), "dump spool could not be written") {
		t.Fatalf("a spool write failure must surface: %v", err)
	}
	s.Close()
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

func TestSpoolCancelUnblocksAReaderAndCloseRemovesEverything(t *testing.T) {
	pr, pw := io.Pipe()
	defer pw.Close()
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	s, err := newDumpSpool(ctx, pr, DumpSpoolOpts{Dir: root, SegBytes: 1000, Free: noMargin, Poll: 5 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	go pw.Write(make([]byte, 3000)) // some bytes on disk, then silence
	eventually(t, "bytes on disk", 5*time.Second, func() bool { d, _ := dirBytes(root); return d > 0 })
	errc := make(chan error, 1)
	go func() {
		buf := make([]byte, 10000)
		for {
			if _, err := s.Read(buf); err != nil {
				errc <- err
				return
			}
		}
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-errc:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("want context.Canceled, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled context did not unblock the reader")
	}
	s.Close()
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
	select {
	case <-s.done:
	default:
		t.Error("the drain goroutine is still running after Close")
	}
}

func TestSpoolCloseUnblocksAPausedDrain(t *testing.T) {
	pr, pw := io.Pipe()
	root := t.TempDir()
	s, err := newDumpSpool(context.Background(), pr, DumpSpoolOpts{Dir: root, SegBytes: 1000, CapBytes: 1000, Free: noMargin, Poll: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			if _, err := pw.Write(make([]byte, 500)); err != nil {
				return
			}
		}
	}()
	eventually(t, "the drain to fill the cap", 5*time.Second, func() bool { d, _ := dirBytes(root); return d >= 1000 })
	time.Sleep(50 * time.Millisecond)
	closed := make(chan struct{})
	go func() { s.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("Close hung on a paused drain")
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

// ---- the whole lane: a dump client that the server cuts when it is not read -------------------------------------------

// timeoutDump models a MariaDB/MySQL server writing a dump into the client's pipe: every write must be taken within `window`,
// else the server drops the connection (net_write_timeout) and the client exits non-zero.
type timeoutDump struct {
	aborted atomic.Bool
	window  time.Duration
	started chan struct{}
}

func installTimeoutDump(t *testing.T, stream []byte, window time.Duration) *timeoutDump {
	t.Helper()
	d := &timeoutDump{window: window, started: make(chan struct{})}
	orig := startDumpFn
	t.Cleanup(func() { startDumpFn = orig })
	startDumpFn = func(ctx context.Context, p Plan) (io.ReadCloser, func() error, error) {
		pr, pw := io.Pipe()
		finished := make(chan error, 1)
		go func() {
			defer close(d.started)
			const chunk = 32 << 10
			for off := 0; off < len(stream); off += chunk {
				end := off + chunk
				if end > len(stream) {
					end = len(stream)
				}
				wrote := make(chan error, 1)
				go func(b []byte) { _, err := pw.Write(b); wrote <- err }(stream[off:end])
				select {
				case err := <-wrote:
					if err != nil { // the client went away
						finished <- nil
						return
					}
				case <-time.After(d.window):
					d.aborted.Store(true)
					pw.Close() // the client's stdout ends (a dead process closes its pipe); its exit status carries the error
					finished <- errors.New("mariadb-dump: Error 2013: Lost connection to server during query when dumping table `blobs` at row: 163710")
					return
				}
			}
			pw.Close()
			finished <- nil
		}()
		return pr, func() error {
			err := <-finished
			if err != nil {
				return fmt.Errorf("%w (exit 3): %v", ErrDumpStream, err)
			}
			return nil
		}, nil
	}
	return d
}

// stalledHub wraps the fake relay hub so that every part upload blocks until `gate` is closed (a hub that is restarting).
func stalledHub(t *testing.T, f *fakeRelayHub) (*Hub, func()) {
	t.Helper()
	gate := make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(gate) }) }
	inner := f.handler()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			select {
			case <-gate:
			case <-r.Context().Done():
				return
			}
		}
		inner.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(release) // runs BEFORE srv.Close: a handler still waiting must be let go
	h := newTestHub(t, srv)
	h.SetOutageWait(0)
	return h, release
}

func dumpOptsWithSpool(dir string, capBytes int64, logf func(string, ...any)) StreamOpts {
	return StreamOpts{PartRawBytes: 64 << 10, RunID: "run_abcdef12", BeatEvery: time.Hour,
		Spool: DumpSpoolOpts{Dir: dir, SegBytes: 256 << 10, CapBytes: capBytes, Free: noMargin, Poll: 5 * time.Millisecond, Logf: logf}}
}

// THE REGRESSION: the hub stalls for longer than the server's write timeout. Without the spool the reader stops after a few
// parts and the dump connection is cut ("Lost connection to server during query"); with it the dump is read at the client's pace
// and delivered when the hub is back.
func TestStreamDumpSurvivesAStalledUploadLongerThanTheServersWriteTimeout(t *testing.T) {
	noSleep(t)
	stream := pgDump(2 << 20)
	dump := installTimeoutDump(t, stream, 500*time.Millisecond)
	f := newFakeRelayHub(t)
	h, release := stalledHub(t, f)
	root := t.TempDir()
	// the hub comes back only after the server's window has long passed, and only once the whole dump is on disk
	go func() {
		select {
		case <-dump.started:
		case <-time.After(20 * time.Second):
		}
		time.Sleep(1500 * time.Millisecond)
		release()
	}()
	res, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", dumpOptsWithSpool(root, 0, nil))
	if dump.aborted.Load() {
		t.Fatalf("the server cut the dump connection while the upload was stalled (err: %v)", err)
	}
	if err != nil {
		t.Fatalf("%v", err)
	}
	if res.RawBytes != int64(len(stream)) || res.Parts != 32 {
		t.Errorf("parts=%d raw=%d", res.Parts, res.RawBytes)
	}
	if got := reassemble(t, f, res.Parts); !bytes.Equal(got, stream) {
		t.Error("the decoded stream differs from the dump")
	}
	if res.SpoolPeakBytes < 1<<20 {
		t.Errorf("the peak backlog %d B must show the dump was read ahead of the stalled upload", res.SpoolPeakBytes)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("the spool was not removed: %v", entries)
	}
}

// When the cap is reached the drain pauses and the client is back to waiting on the upload (today's behaviour), and the
// migrator says so once.
func TestStreamDumpCapReachedFallsBackToBackPressureAndLogsOnce(t *testing.T) {
	noSleep(t)
	stream := pgDump(2 << 20)
	dump := installTimeoutDump(t, stream, 400*time.Millisecond)
	f := newFakeRelayHub(t)
	h, open := stalledHub(t, f)
	root := t.TempDir()
	// the hub answers only after the server has cut the connection: a dump that fails is reported when its parts have been sent
	go func() { <-dump.started; time.Sleep(100 * time.Millisecond); open() }()
	var logs atomic.Int32
	_, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", dumpOptsWithSpool(root, 512<<10, func(string, ...any) { logs.Add(1) }))
	if !dump.aborted.Load() {
		t.Fatal("the cap is far below the dump and the hub never answers: the server must have cut the connection")
	}
	if !errors.Is(err, ErrDumpStream) || !strings.Contains(err.Error(), "Lost connection to server") {
		t.Fatalf("want the dump client's own error, got %v", err)
	}
	if logs.Load() != 1 {
		t.Errorf("the pause was logged %d times, want once", logs.Load())
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("the spool was not removed: %v", entries)
	}
}

func TestStreamDumpClientFailureReportsItAndRemovesTheSpool(t *testing.T) {
	noSleep(t)
	fakeDump(t, pgDump(300000), fmt.Errorf("%w (exit 3): mariadb-dump: Error 2013", ErrDumpStream))
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	root := t.TempDir()
	_, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", dumpOptsWithSpool(root, 0, nil))
	if !errors.Is(err, ErrDumpStream) || !strings.Contains(err.Error(), "exit 3") {
		t.Fatalf("a failed client must fail the dump with its own message: %v", err)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("the spool was not removed: %v", entries)
	}
}

func TestStreamDumpWrongHeaderRemovesTheSpool(t *testing.T) {
	noSleep(t)
	garbage := streamBytes(300000)
	garbage[0] = 'X'
	fakeDump(t, garbage, nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	root := t.TempDir()
	_, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", dumpOptsWithSpool(root, 0, nil))
	if !errors.Is(err, ErrDumpStream) {
		t.Fatalf("%v", err)
	}
	if len(f.putBodies) != 0 {
		t.Error("nothing may be delivered from a stream that failed its format check")
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("the spool was not removed: %v", entries)
	}
}

func TestStreamDumpCancelWhileTheUploadIsStalledRemovesTheSpool(t *testing.T) {
	noSleep(t)
	dump := installTimeoutDump(t, pgDump(2<<20), time.Minute)
	f := newFakeRelayHub(t)
	h, _ := stalledHub(t, f) // never released by the test itself (released at cleanup)
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-dump.started // the whole dump is on disk
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	type result struct {
		res StreamResult
		err error
	}
	out := make(chan result, 1)
	go func() {
		res, err := StreamDump(ctx, h, testPlan, "volume:s:a:dump", dumpOptsWithSpool(root, 0, nil))
		out <- result{res, err}
	}()
	select {
	case r := <-out:
		if !errors.Is(r.err, context.Canceled) {
			t.Errorf("a cancelled run must return the context error, got %v", r.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("StreamDump did not return after the context was cancelled")
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("the spool was not removed: %v", entries)
	}
}

// A spool directory that cannot be made leaves the direct pipe (and says so) instead of failing a dump that used to work.
func TestStreamDumpFallsBackToTheDirectPipeWhenTheSpoolCannotBeMade(t *testing.T) {
	noSleep(t)
	stream := pgDump(150000)
	fakeDump(t, stream, nil)
	f := newFakeRelayHub(t)
	h := newStreamHub(t, f)
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	var logged atomic.Int32
	o := dumpOptsWithSpool(filepath.Join(blocker, "sub"), 0, func(string, ...any) { logged.Add(1) }) // a path below a regular file
	res, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", o)
	if err != nil {
		t.Fatal(err)
	}
	if logged.Load() != 1 || res.SpoolPeakBytes != 0 {
		t.Errorf("logged=%d peak=%d", logged.Load(), res.SpoolPeakBytes)
	}
	if got := reassemble(t, f, res.Parts); !bytes.Equal(got, stream) {
		t.Error("the decoded stream differs from the dump")
	}
}

// ---- the CLI: flags and the item result ---------------------------------------------------------------------------------

func TestDumpRunSpoolsThroughTheConfiguredDirAndReportsThePeakBacklog(t *testing.T) {
	hub := dumpHub(t)
	d := &dumpDocker{running: true, started: []string{dumpStarted}}
	stream := pgDump(3000)
	fakeDump(t, stream, nil)
	dir := t.TempDir()
	out, code, stderr := runDumpCLI(t, hub, d, "--arms", "all", "--dump-spool-dir", dir, "--dump-spool-mib", "64")
	if code != exitOK || len(out.Items) != 1 {
		t.Fatalf("exit=%d out=%+v stderr=%s", code, out, stderr)
	}
	it := out.Items[0]
	if it.State != "volume-applied" || it.SpoolPeakBytes != 3000 {
		t.Errorf("item: %+v", it)
	}
	if got := reassemble(t, hub.fakeRelayHub, 1); !bytes.Equal(got, stream) {
		t.Error("the relay received something other than the dump")
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("the spool was not removed: %v", entries)
	}
	b, _ := json.Marshal(it)
	if !strings.Contains(string(b), `"spoolPeakBytes":3000`) {
		t.Errorf("the result JSON must carry spoolPeakBytes: %s", b)
	}
	// the field is optional: a database item that never spooled does not carry it
	b, _ = json.Marshal(itemResult{ItemRef: "x", State: "ok"})
	if strings.Contains(string(b), "spool") {
		t.Errorf("an item with no spool must not carry the field: %s", b)
	}
}

func TestDumpSpoolFlagsAreValidated(t *testing.T) {
	for _, bad := range [][]string{{"--dump-spool-mib", "-1"}, {"--dump-spool-mib", "4194305"}, {"--dump-spool-dir", "relative/dir"}, {"--dump-spool-dir", "/a/../b"}} {
		var stderr bytes.Buffer
		if _, err := parseFlags(bad, &stderr); err == nil {
			t.Errorf("%v must be refused", bad)
		}
	}
	c, err := parseFlags([]string{"--dump-spool-dir", "/dump-spool", "--dump-spool-mib", "4096"}, io.Discard)
	if err != nil || c.dumpSpoolDir != "/dump-spool" || c.dumpSpoolMiB != 4096 {
		t.Errorf("%+v %v", c, err)
	}
	if c, err = parseFlags(nil, io.Discard); err != nil || c.dumpSpoolMiB != defaultDumpSpoolMiB || c.dumpSpoolDir != "" {
		t.Errorf("defaults: %+v %v", c, err)
	}
}

// ---- review follow-ups --------------------------------------------------------------------------------------------------

// Close can land between the reader opening a segment and registering its handle: that handle must not outlive the spool.
func TestSpoolReadAfterCloseDoesNotKeepASegmentHandleOpen(t *testing.T) {
	s, _ := spoolFor(t, io.NopCloser(bytes.NewReader(streamBytes(2500))), DumpSpoolOpts{SegBytes: 1000, Free: noMargin})
	eventually(t, "the stream to be drained", 5*time.Second, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.eof
	})
	s.mu.Lock()
	seg := s.segs[0]
	s.mu.Unlock()
	s.afterOpen = func() { s.Close() }
	n, err := s.Read(make([]byte, 100))
	if n != 0 || !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("a read racing Close must fail with ErrClosedPipe, got n=%d err=%v", n, err)
	}
	s.mu.Lock()
	rf := seg.rf
	s.mu.Unlock()
	if rf != nil {
		t.Error("the segment handle opened after Close was kept (a leaked file descriptor)")
	}
}

// A dump client that failed is reported when its stream ends, not after the whole backlog has been uploaded.
func TestStreamDumpClientFailureStopsTheUploadOfTheBacklog(t *testing.T) {
	noSleep(t)
	stream := pgDump(2 << 20) // 32 parts of 64 KiB, all of them on disk at once
	fakeDump(t, stream, fmt.Errorf("%w (exit 3): mariadb-dump: Error 2013: Lost connection", ErrDumpStream))
	f := newFakeRelayHub(t)
	h, release := stalledHub(t, f)
	go func() { time.Sleep(300 * time.Millisecond); release() }() // the hub is back long after the client has finished and failed
	root := t.TempDir()
	_, err := StreamDump(context.Background(), h, testPlan, "volume:s:a:dump", dumpOptsWithSpool(root, 0, nil))
	if !errors.Is(err, ErrDumpStream) || !strings.Contains(err.Error(), "exit 3") || !strings.Contains(err.Error(), "Lost connection") {
		t.Fatalf("want the dump client's own error, got %v", err)
	}
	if strings.Contains(err.Error(), "reading the archive") {
		t.Errorf("the client's error must not be re-wrapped as an archive read error: %v", err)
	}
	if n := len(f.putBodies); n >= 8 {
		t.Errorf("%d of 32 parts were uploaded although the client had already failed", n)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Errorf("the spool was not removed: %v", entries)
	}
}

// Flushing a sealed segment must not stop the drain from reading the client: a slow disk would otherwise hold the pipe for as
// long as one fsync, the very stall the spool exists to remove.
func TestSpoolSegmentFlushDoesNotStallTheDrain(t *testing.T) {
	gate := make(chan struct{})
	var syncs atomic.Int32
	pr, pw := io.Pipe()
	root := t.TempDir()
	s, err := newDumpSpool(context.Background(), pr, DumpSpoolOpts{Dir: root, SegBytes: 1000, Free: noMargin, Poll: 5 * time.Millisecond,
		Sync: func(f *os.File) error { syncs.Add(1); <-gate; return f.Sync() }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		select {
		case <-gate:
		default:
			close(gate)
		}
		s.Close()
	})
	data := streamBytes(4500)
	written := make(chan error, 1)
	go func() {
		for off := 0; off < len(data); off += 500 {
			if _, err := pw.Write(data[off : off+500]); err != nil {
				written <- err
				return
			}
		}
		written <- pw.Close()
	}()
	select {
	case err := <-written:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the drain stopped reading the client while a sealed segment was being flushed")
	}
	if syncs.Load() == 0 {
		t.Fatal("no segment was flushed")
	}
	close(gate)
	got, err := io.ReadAll(s)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("round trip: err=%v equal=%v", err, bytes.Equal(got, data))
	}
}

// A failed flush still fails the spool (and is not lost behind a clean end of stream).
func TestSpoolSegmentFlushErrorIsReturnedToTheReader(t *testing.T) {
	boom := errors.New("input/output error")
	s, _ := spoolFor(t, io.NopCloser(bytes.NewReader(streamBytes(2500))), DumpSpoolOpts{SegBytes: 1000, Free: noMargin,
		Sync: func(*os.File) error { return boom }})
	_, err := io.ReadAll(s)
	if !errors.Is(err, boom) {
		t.Fatalf("want the flush error, got %v", err)
	}
}
