package migrate

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Streaming failures. run.go maps each to an item state.
var (
	// ErrDiverged: a slice's RAW hash differs from what the hub already committed for it (the source changed, or the
	// tar stream is not deterministic). Never recovered automatically: the owner resets the volume.
	ErrDiverged = errors.New("the source no longer matches the parts the hub already holds")
	// ErrTarFailed: the helper tar exited non-zero (a truncated stream is never accepted).
	ErrTarFailed = errors.New("the tar helper failed")
	// ErrPartFailed: a part could not be delivered after its retries.
	ErrPartFailed = errors.New("a part could not be delivered")
)

// StreamOpts parameterises one volume stream.
type StreamOpts struct {
	PartRawBytes int
	Helper       string
	RunID        string
	Excludes     []string
	Progress     func(Progress)
	// ResumeFromPart / Manifest come from `begin`: slices below ResumeFromPart are only read and hashed.
	ResumeFromPart int
	Manifest       []VxManifestEntry
	// TotalRaw is the inventory size (advisory, for progress only).
	TotalRaw int64
	// BeatEvery is how often the lease is renewed while no other call is made (default 60 s).
	BeatEvery time.Duration
	// MaxParts is the hub's part-count ceiling (names are 5 digits).
	MaxParts int
}

// Progress is reported once per committed part.
type Progress struct {
	Part      int
	RawDone   int64
	RawTotal  int64
	Committed int64 // compressed bytes the hub confirmed this run
}

// StreamResult is what a completed stream hands to `finish`.
type StreamResult struct {
	Parts           int
	RawBytes        int64
	CompressedBytes int64
}

// buildTarArgv is the helper-container command (golden-tested). The helper is the migrator's OWN image, never pulled;
// `--sort=name --numeric-owner --format=gnu` make the archive deterministic (resume compares raw hashes) and keep numeric
// ids (an empty uname/gname can never be re-mapped by the target's busybox tar). No shell is involved anywhere.
func buildTarArgv(dockerPath, helper, mountSrc, name string, excludes []string) []string {
	argv := []string{dockerPath, "run"}
	argv = append(argv, helperHardening(name)...)
	argv = append(argv, "-v", mountSrc+":/data:ro", "--entrypoint", "tar", helper, "--sort=name", "--numeric-owner", "--format=gnu")
	for _, e := range excludes {
		argv = append(argv, "--exclude=./"+e)
	}
	return append(argv, "-C", "/data", "-cf", "-", ".")
}

// startTarFn starts the tar helper and returns its stdout and a wait func. Package var so tests stream bytes without
// docker. The default kills the helper with SIGTERM on cancel (a SIGKILL of the docker CLI would orphan the container).
var startTarFn = func(ctx context.Context, argv []string, env []string) (io.ReadCloser, func() error, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 15 * time.Second
	var stderr limitedBuf
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	return out, func() error {
		if err := cmd.Wait(); err != nil {
			return fmt.Errorf("%w: %v (%s)", ErrTarFailed, err, firstLine(strings.TrimSpace(stderr.String())))
		}
		return nil
	}, nil
}

// limitedBuf keeps the first 2 KiB of a stream (tar's complaint), discarding the rest.
type limitedBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *limitedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if room := 2048 - l.buf.Len(); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		l.buf.Write(p[:room])
	}
	return len(p), nil
}

func (l *limitedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// readSlice fills buf from r and returns the number of bytes read and their sha256. A slice shorter than buf is the LAST
// one (n < len(buf), err == nil); n == 0 with io.EOF means the stream ended exactly on the previous slice boundary.
func readSlice(r io.Reader, buf []byte) (n int, rawSum [32]byte, err error) {
	n, err = io.ReadFull(r, buf)
	if err == io.ErrUnexpectedEOF {
		err = nil
	}
	if n > 0 {
		rawSum = sha256.Sum256(buf[:n])
	}
	if err == io.EOF && n == 0 {
		return 0, rawSum, io.EOF
	}
	return n, rawSum, err
}

// memberWriter is a reusable gzip writer: each call yields ONE independent gzip member (zero header, BestSpeed), so
// concatenated members are a single valid gzip stream (`cat p.* | gunzip`) and every part verifies alone.
type memberWriter struct{ gw *gzip.Writer }

func newMemberWriter() *memberWriter {
	gw, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
	return &memberWriter{gw: gw}
}

func (m *memberWriter) compress(raw []byte, out *bytes.Buffer) (sum [32]byte, err error) {
	out.Reset()
	// Pre-size to the worst case (incompressible data): a bytes.Buffer that grows by doubling reaches ~2x the member
	// while the old and new backing arrays are both alive (a 128 MiB member -> a 256 MiB capacity plus a 128 MiB copy
	// mid-grow). Reset keeps the capacity, so the two pooled buffers never reallocate after the first full slice.
	out.Grow(memberBound(len(raw)))
	m.gw.Reset(out)
	m.gw.Header = gzip.Header{} // no name, no mtime: deterministic bytes
	if _, err = m.gw.Write(raw); err != nil {
		return sum, err
	}
	if err = m.gw.Close(); err != nil {
		return sum, err
	}
	return sha256.Sum256(out.Bytes()), nil
}

// memberBound is an upper bound for one gzip member of n raw bytes at BestSpeed: incompressible data is emitted as stored
// blocks (5 bytes of framing per block of at least 16 KiB), plus the 10-byte header, the 8-byte trailer and a final empty
// block. n/256 is a >10x margin over the framing; a stream that still exceeds it only costs one regrow, never correctness.
func memberBound(n int) int { return n + n/256 + 1024 }

// compressMember is the stateless form (tests and one-offs).
func compressMember(raw []byte, out *bytes.Buffer) (sum [32]byte, err error) {
	return newMemberWriter().compress(raw, out)
}

// partJob is one slice ready to send: its raw descriptor and the compressed member (owned until released).
type partJob struct {
	idx      int
	rawOff   int64
	rawLen   int
	rawSha   string
	member   *bytes.Buffer
	memSha   string
	last     bool
	skip     bool // a resumed part: only verified, nothing to send
	err      error
	released chan<- *bytes.Buffer
}

// isRetryablePartErr: transport and transient hub errors are worth re-sending the same buffer for; a classified
// conflict (diverged, aborted, lease lost, disk) never is.
func isRetryablePartErr(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var he *HubError
	if errors.As(err, &he) {
		switch he.Kind {
		case KindServer, KindRateLimited, KindVxPartLost, KindBusyUpload:
			return true
		case KindNotFound:
			return he.Status == 404 // a relay rendezvous that vanished (the hub restarted)
		}
		return he.Status == 422 || he.Status == 502 || he.Status == 503 || he.Status == 504
	}
	return true // a bare transport error
}

// StreamVolume runs the tar helper over the (stopped) source, cuts its stream into independent gzip members of at most
// PartRawBytes raw bytes, and delivers each through the hub's memory relay: register -> PUT -> commit. Slices already
// committed by an earlier run are only re-read and compared by RAW hash (no network). Memory: one raw slice buffer plus
// two member buffers, each pre-sized once to the incompressible worst case (memberBound) and reused for every slice.
// It returns after the last commit; the caller then re-verifies the source and calls `finish`.
func StreamVolume(ctx context.Context, h *Hub, dockerPath string, env []string, tg Target, s *volSource, o StreamOpts) (StreamResult, error) {
	if o.Helper == "" {
		return StreamResult{}, ErrNoHelper
	}
	if o.PartRawBytes < 1 {
		return StreamResult{}, errors.New("no part size")
	}
	src, err := s.mountSrc()
	if err != nil {
		return StreamResult{}, err
	}
	name := "tugra-vx-" + shortRun(o.RunID) + "-" + shortID(s.ContainerID)
	argv := buildTarArgv(dockerPath, o.Helper, src, name, o.Excludes)

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stdout, wait, err := startTarFn(sctx, argv, env)
	if err != nil {
		return StreamResult{}, fmt.Errorf("%w: could not start the helper", ErrTarFailed)
	}
	defer func() { removeHelper(dockerPath, env, name) }() // a crashed/cancelled run never leaves the helper container behind

	return deliverParts(sctx, cancel, ctx, h, tg.ItemRef, o, stdout, wait, o.ResumeFromPart > 0)
}

// deliverParts is the part pipeline shared by the volume tar stream and the streamed database dump: it cuts `stdout` into
// independent gzip members, delivers each through the hub's relay and returns after the last commit. `beat` keeps the lease
// alive while no other call is made (a resumed volume re-reading its committed prefix; a dump whose producer is slow).
// `wait` reports the producer's exit status; a truncated or failed stream is never accepted. sctx is the cancellable child of
// ctx that the producer reads under; cancel stops it.
func deliverParts(sctx context.Context, cancel context.CancelFunc, ctx context.Context, h *Hub, itemRef string, o StreamOpts, stdout io.ReadCloser, wait func() error, beat bool) (StreamResult, error) {
	// While no other call is made (a resumed volume re-reading its committed prefix, a dump whose producer is slow) keep the lease alive.
	beatPhase := "skipping"
	if o.ResumeFromPart == 0 {
		beatPhase = "streaming"
	}
	beatEvery := o.BeatEvery
	if beatEvery <= 0 {
		beatEvery = 60 * time.Second
	}
	stopBeat := make(chan struct{})
	var beatWG sync.WaitGroup
	if beat {
		beatWG.Add(1)
		go func() {
			defer beatWG.Done()
			t := time.NewTicker(beatEvery)
			defer t.Stop()
			for {
				select {
				case <-stopBeat:
					return
				case <-sctx.Done():
					return
				case <-t.C:
					_ = h.VxBeat(sctx, itemRef, o.RunID, beatPhase)
				}
			}
		}()
	}

	jobs := make(chan partJob, 1)
	free := make(chan *bytes.Buffer, 2)
	free <- new(bytes.Buffer)
	free <- new(bytes.Buffer)
	limitMigratorMemory()
	go produce(sctx, stdout, o, jobs, free)

	var res StreamResult
	var sendErr error
	committedBytes := int64(0)
	stopped := false
	for j := range jobs {
		if stopped {
			continue // drain so the producer can exit
		}
		if j.err != nil {
			sendErr = j.err
			stopped = true
			cancel()
			continue
		}
		if j.skip {
			res.Parts++
			res.RawBytes += int64(j.rawLen)
			if j.last {
				break
			}
			continue
		}
		if err := sendPart(sctx, h, itemRef, o.RunID, j); err != nil {
			sendErr = err
			stopped = true
			cancel()
			continue
		}
		res.Parts++
		res.RawBytes += int64(j.rawLen)
		res.CompressedBytes += int64(j.member.Len())
		committedBytes += int64(j.member.Len())
		if o.Progress != nil {
			o.Progress(Progress{Part: j.idx, RawDone: res.RawBytes, RawTotal: o.TotalRaw, Committed: committedBytes})
		}
		j.released <- j.member
		if j.last {
			break
		}
	}
	close(stopBeat)
	beatWG.Wait()
	// the producer may still be blocked reading tar: closing stdout unblocks it
	_ = stdout.Close()
	for range jobs { // drain
	}
	werr := wait()
	if sendErr != nil {
		return res, sendErr
	}
	if ctx.Err() != nil {
		return res, ctx.Err()
	}
	if werr != nil {
		return res, werr // a truncated or failed archive is never accepted
	}
	if res.Parts == 0 {
		return res, fmt.Errorf("%w: the archive is empty", ErrTarFailed)
	}
	if o.MaxParts > 0 && res.Parts > o.MaxParts {
		return res, errors.New("the volume exceeds the hub's part limit")
	}
	return res, nil
}

// migratorMemLimit is the Go runtime soft limit the streamer installs. The migrator container runs with
// `--memory=768m --memory-swap=768m` (no swap escape: an overrun is an OOM kill, exit 137, with no message). The live set
// is one raw slice plus two member buffers (about 3 x 128 MiB at the hub's largest part) and a few MiB of buffers, so
// 600 MiB lets the GC reclaim garbage (dropped request bodies, old members) BEFORE the cgroup limit while staying below it.
const migratorMemLimit = 600 << 20

var memLimitOnce sync.Once

// limitMigratorMemory installs the soft memory limit once per process. It lives in the streamer entry (not in run.go)
// because only the volume arm holds slice-sized buffers; the migrate subcommand reaches it before the first slice is read.
func limitMigratorMemory() {
	memLimitOnce.Do(func() { applyMemoryLimit(os.LookupEnv, debug.SetMemoryLimit) })
}

// applyMemoryLimit sets migratorMemLimit through set, unless the operator exported GOMEMLIMIT (their value wins: the
// runtime has already applied it at start). It reports whether it set the limit.
func applyMemoryLimit(getenv func(string) (string, bool), set func(int64) int64) bool {
	if v, ok := getenv("GOMEMLIMIT"); ok && strings.TrimSpace(v) != "" {
		return false
	}
	set(migratorMemLimit)
	return true
}

func shortRun(run string) string {
	run = strings.TrimPrefix(run, "run_")
	if len(run) > 8 {
		return run[:8]
	}
	return run
}

// produce reads the tar stream slice by slice, hashes each RAW slice, and either verifies it against the hub manifest
// (resumed parts) or compresses it into a member buffer. At most two member buffers exist (the second is filled while the
// first is in flight). A one-byte look-ahead after a FULL slice tells whether it was the last one.
func produce(ctx context.Context, r io.Reader, o StreamOpts, jobs chan<- partJob, free chan *bytes.Buffer) {
	defer close(jobs)
	br := bufio.NewReaderSize(r, 1<<20)
	raw := make([]byte, o.PartRawBytes)
	mw := newMemberWriter()
	var off int64
	for idx := 0; ; idx++ {
		if ctx.Err() != nil {
			return
		}
		n, sum, err := readSlice(br, raw)
		if err == io.EOF {
			jobs <- partJob{err: fmt.Errorf("%w: the archive is empty", ErrTarFailed)}
			return
		}
		if err != nil {
			jobs <- partJob{err: fmt.Errorf("%w: reading the archive: %v", ErrTarFailed, err)}
			return
		}
		last := n < len(raw)
		if !last {
			if _, perr := br.Peek(1); perr == io.EOF {
				last = true
			} else if perr != nil {
				jobs <- partJob{err: fmt.Errorf("%w: reading the archive: %v", ErrTarFailed, perr)}
				return
			}
		}
		rawSha := hex.EncodeToString(sum[:])
		if idx < o.ResumeFromPart {
			var want *VxManifestEntry
			if idx < len(o.Manifest) {
				want = &o.Manifest[idx]
			}
			// the hub already holds this slice: it must be byte-identical (raw hash), or the source is not what was copied
			if want == nil || want.Idx != idx || want.RawLen != n || want.RawSha256 != rawSha || want.RawOffset != off {
				jobs <- partJob{err: ErrDiverged}
				return
			}
			if last && idx != o.ResumeFromPart-1 {
				jobs <- partJob{err: ErrDiverged} // the stream ends before the committed parts do
				return
			}
			off += int64(n)
			jobs <- partJob{idx: idx, rawOff: off - int64(n), rawLen: n, rawSha: rawSha, skip: true, last: last}
			if last {
				return
			}
			continue
		}
		var mb *bytes.Buffer
		select {
		case mb = <-free:
		case <-ctx.Done():
			return
		}
		msum, cerr := mw.compress(raw[:n], mb)
		if cerr != nil {
			jobs <- partJob{err: cerr}
			return
		}
		jobs <- partJob{idx: idx, rawOff: off, rawLen: n, rawSha: rawSha, member: mb, memSha: hex.EncodeToString(msum[:]), last: last, released: free}
		off += int64(n)
		if last {
			return
		}
	}
}

// sendPart delivers one member: register -> PUT -> commit, re-registering the SAME in-memory buffer on a failure. Up to 3
// ordinary attempts; a hub restart (404/502/503/504, `vx-part-lost`) is waited out for the outage window instead of being
// counted. A classified conflict (diverged, aborted, fingerprint, disk) is returned at once.
func sendPart(ctx context.Context, h *Hub, itemRef, runID string, j partJob) error {
	req := VxPartReq{RunID: runID, RawOffset: j.rawOff, RawLen: j.rawLen, RawSha256: j.rawSha, Size: j.member.Len(), Sha256: j.memSha}
	var lastErr error
	attempts := 0
	var outageUntil time.Time
	for attempts < 3 {
		if err := ctx.Err(); err != nil {
			return err
		}
		reg, err := h.VxRegisterPart(ctx, itemRef, j.idx, req)
		if err != nil {
			if isOutage(err) && h.outageOpen(&outageUntil) {
				if werr := waitRetry(ctx, jitter(5*time.Second)); werr != nil {
					return werr
				}
				continue
			}
			return err
		}
		if reg.AlreadyDone {
			return nil
		}
		if err = h.VxPutPart(ctx, reg.SrcPath, j.member.Bytes()); err != nil {
			lastErr = err
			if isOutage(err) && h.outageOpen(&outageUntil) {
				if werr := waitRetry(ctx, jitter(5*time.Second)); werr != nil {
					return werr
				}
				continue
			}
			if !isRetryablePartErr(err) {
				return err
			}
			attempts++
			if werr := waitRetry(ctx, jitter(2*time.Second)); werr != nil {
				return werr
			}
			continue
		}
		c, cerr := h.VxCommit(ctx, itemRef, j.idx, runID)
		if cerr != nil {
			lastErr = cerr
			if kindOf(cerr) == KindVxPartLost || (isOutage(cerr) && h.outageOpen(&outageUntil)) {
				if werr := waitRetry(ctx, jitter(3*time.Second)); werr != nil {
					return werr
				}
				continue // re-register the same part with the same buffer; the target's receive is idempotent
			}
			return cerr
		}
		if c.Done {
			return nil
		}
		lastErr = fmt.Errorf("%w: %s", ErrPartFailed, c.Reason)
		if !c.Retryable {
			return lastErr
		}
		attempts++
		if werr := waitRetry(ctx, jitter(2*time.Second)); werr != nil {
			return werr
		}
	}
	if lastErr == nil {
		lastErr = ErrPartFailed
	}
	return fmt.Errorf("%w: %v", ErrPartFailed, lastErr)
}

// isOutage reports a hub that is restarting or unreachable (worth waiting for), as opposed to an answer.
func isOutage(err error) bool {
	var he *HubError
	if errors.As(err, &he) {
		return he.Status == 404 || he.Status == 502 || he.Status == 503 || he.Status == 504 || (he.Kind == KindServer && he.Status == 0)
	}
	return false
}

// removeHelper force-removes the helper container by name (best effort, never the source container).
func removeHelper(dockerPath string, env []string, name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, _, _ = runDocker(ctx, []string{dockerPath, "rm", "-f", name}, env)
}

// reapStaleHelpers removes helper containers a crashed earlier run left behind (label tugra.vx=1, ONLY those). A helper
// whose owner (another migrator container on this host) is still running belongs to a live run and is left alone.
func reapStaleHelpers(ctx context.Context, dockerPath string, env []string) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, _, err := runDocker(cctx, []string{dockerPath, "ps", "-a", "--no-trunc", "--filter", "label=tugra.vx=1", "--format", `{{.ID}} {{.Label "tugra.vx.owner"}}`}, env)
	if err != nil {
		return
	}
	alive := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || !hex64Re.MatchString(f[0]) {
			continue
		}
		if len(f) > 1 && f[1] != helperOwner && ownerRe.MatchString(f[1]) {
			live, seen := alive[f[1]]
			if !seen {
				live = ownerRunning(cctx, dockerPath, env, f[1])
				alive[f[1]] = live
			}
			if live {
				continue
			}
		}
		_, _, _ = runDocker(cctx, []string{dockerPath, "rm", "-f", f[0]}, env)
	}
}

// ownerRunning reports whether the container named by a helper's owner label is running. Any error (gone, not a
// container) counts as not running, so a crashed run's helpers are still reaped.
func ownerRunning(ctx context.Context, dockerPath string, env []string, owner string) bool {
	out, _, err := runDocker(ctx, []string{dockerPath, "inspect", "-f", "{{.State.Running}}", "--type", "container", owner}, env)
	return err == nil && strings.TrimSpace(string(out)) == "true"
}
