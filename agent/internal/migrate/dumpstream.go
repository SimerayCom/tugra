package migrate

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The STREAMED DATABASE DUMP lane. A database too big for the 256 MiB artifact route (or one that cannot be copied as files)
// is dumped by its own pinned, no-shell dump recipe (pg_dump custom format / mariadb-dump) and the dump's stdout is cut into
// the SAME independent gzip members the volume arm sends, delivered through the same relay (register -> PUT -> commit), staged
// on the target and restored there STREAMING (`cat p.* | gunzip | pg_restore`): no spool file on the source, no decoded dump on
// the target, no size cap but the hub's per-dump limit.
//
// A dump is not byte-deterministic (its header carries the dump time), so unlike a tar of a stopped volume it cannot be
// resumed from the middle by comparing raw hashes. What IS resumable: every part retries from the SAME in-memory buffer, a hub
// outage or restart is waited out while the dump keeps flowing into a bounded on-disk spool (dumpspool.go; once its cap is reached the
// producer is paused by back-pressure again: the pipe fills, the dump blocks), and a transfer
// whose parts are all staged but whose restore failed is re-applied without dumping again. A migrator that dies mid-stream
// starts the dump over (the hub discards the stale parts at the next `begin`): that is stated, never hidden.

var (
	// ErrDumpStream: the dump process failed or produced something that is not the expected archive.
	ErrDumpStream = errors.New("the database dump failed")
)

// dumpExitKillGrace bounds how long a cancelled dump client is given before it is killed.
const dumpExitKillGrace = 15 * time.Second

// startDumpFn starts the pinned dump command and returns its stdout and a wait func. Package var so tests stream bytes
// without docker. The child never inherits os.Environ(): p.Env is the closed allowlist plus the one bound secret.
var startDumpFn = func(ctx context.Context, p Plan) (io.ReadCloser, func() error, error) {
	if len(p.Env) == 0 || len(p.Argv) == 0 {
		return nil, nil, errors.New("refusing to run a dump with an empty argv or env")
	}
	cmd := exec.CommandContext(ctx, p.Argv[0], p.Argv[1:]...)
	cmd.Env = p.Env
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// SIGKILL of the host-side `docker exec` client group on cancel; the in-container dumper dies on EPIPE at its next write
	// (the same limit dumpOne documents).
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = dumpExitKillGrace
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
			var ee *exec.ExitError
			why := stderr.lastLine() // the dump client's own error (never a credential: passwords ride the environment)
			if errors.As(err, &ee) {
				if why != "" {
					return fmt.Errorf("%w (exit %d): %s", ErrDumpStream, ee.ExitCode(), why)
				}
				return fmt.Errorf("%w (exit %d)", ErrDumpStream, ee.ExitCode())
			}
			return fmt.Errorf("%w: %v", ErrDumpStream, err)
		}
		return nil
	}, nil
}

// sanityReader checks the dump's first bytes against the engine's expected header before anything is sent: "exit 0 but
// garbage" must not reach the target. A mismatch surfaces as a read error (the producer reports it, nothing is committed).
type sanityReader struct {
	r      io.ReadCloser
	engine string
	head   []byte
	done   bool
}

func (s *sanityReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if !s.done && n > 0 {
		if need := 16 - len(s.head); need > 0 {
			if need > n {
				need = n
			}
			s.head = append(s.head, p[:need]...)
		}
		if len(s.head) >= 16 {
			s.done = true
			if ferr := formatSanity(s.engine, s.head); ferr != nil {
				return 0, ferr
			}
		}
	}
	return n, err
}

func (s *sanityReader) Close() error { return s.r.Close() }

// StreamDump runs the dump plan and delivers its stdout as parts. It starts at part 0 always (a dump cannot resume from the
// middle). It returns after the last commit; the caller then re-checks the source and calls `finish`.
func StreamDump(ctx context.Context, h *Hub, p Plan, itemRef string, o StreamOpts) (StreamResult, error) {
	if o.PartRawBytes < 1 {
		return StreamResult{}, errors.New("no part size")
	}
	o.ResumeFromPart, o.Manifest = 0, nil
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stdout, wait, err := startDumpFn(sctx, p)
	if err != nil {
		return StreamResult{}, fmt.Errorf("%w: could not start the dump", ErrDumpStream)
	}
	limitMigratorMemory()
	// The exit status is read once: the spool's drain asks for it at the end of the stream, deliverParts again afterwards.
	var waitOnce sync.Once
	var waitErr error
	rawWait := wait
	wait = func() error { waitOnce.Do(func() { waitErr = rawWait() }); return waitErr }
	// The dump client's stdout is drained into an on-disk spool as fast as the client writes it, so a stalled upload (a hub
	// restart) never stops the reader: the server would cut the dump connection at its net_write_timeout. A spool that cannot be
	// made leaves the direct pipe (the old behaviour, back-pressure only) and says so.
	var src io.ReadCloser = stdout
	var spool *dumpSpool
	so := o.Spool
	so.Exit = wait // a client that failed is noticed when its stream ends, not after the whole backlog has been uploaded
	if sp, serr := newDumpSpool(sctx, stdout, so); serr != nil {
		if o.Spool.Logf != nil {
			o.Spool.Logf("dump spool: unavailable (%v); the dump is read only as fast as it is uploaded", serr)
		}
	} else {
		spool, src = sp, sp
		defer spool.Close() // every exit path removes the segments and the directory (deliverParts closes it first)
	}
	res, derr := deliverParts(sctx, cancel, ctx, h, itemRef, o, &sanityReader{r: src, engine: p.Engine}, wait, true)
	if spool != nil {
		res.SpoolPeakBytes = spool.PeakBacklog()
	}
	var xe *dumpExitError
	if errors.As(derr, &xe) { // the spool stopped the upload because the client had already failed: its own error is the result
		derr = xe.err
	}
	if derr != nil && errors.Is(derr, ErrTarFailed) {
		derr = fmt.Errorf("%w: %v", ErrDumpStream, strings.TrimPrefix(derr.Error(), ErrTarFailed.Error()+": "))
	}
	if derr != nil && errors.Is(derr, errBadFormat) && !errors.Is(derr, ErrDumpStream) {
		derr = fmt.Errorf("%w: %v", ErrDumpStream, derr)
	}
	return res, derr
}

// ---- measuring a dump without keeping it ----------------------------------------------------------------------------

// countSink counts bytes and discards them.
type countSink struct{ n int64 }

func (c *countSink) Write(p []byte) (int, error) { c.n += int64(len(p)); return len(p), nil }

// DumpSize is what a counted (discarded) dump yields: the raw size and the size the artifact route would have to carry (the
// same gzip level the artifact route uses), so "does it fit the cap" is decided by the dump, never by the volume.
type DumpSize struct {
	RawBytes int64
	GzBytes  int64
}

// MeasureDump runs the dump plan to a counting sink (nothing is written to disk) and returns its raw and gzip sizes. It is
// bounded by timeout; a dump that exceeds it, exits non-zero or fails the format check yields an error (the caller reports the
// database as not measured and the hub fails closed).
func MeasureDump(ctx context.Context, p Plan, timeout time.Duration) (DumpSize, error) {
	var ds DumpSize
	mctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stdout, wait, err := startDumpFn(mctx, p)
	if err != nil {
		return ds, fmt.Errorf("%w: could not start the dump", ErrDumpStream)
	}
	gzSink := &countSink{}
	gz, _ := gzip.NewWriterLevel(gzSink, gzip.BestSpeed)
	src := &sanityReader{r: stdout, engine: p.Engine}
	buf := make([]byte, 1<<20)
	var readErr error
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			ds.RawBytes += int64(n)
			if _, werr := gz.Write(buf[:n]); werr != nil {
				readErr = werr
				break
			}
		}
		if rerr != nil {
			if rerr != io.EOF {
				readErr = rerr
			}
			break
		}
	}
	_ = gz.Close()
	_ = stdout.Close()
	ds.GzBytes = gzSink.n
	werr := wait()
	switch {
	case ctx.Err() != nil:
		return ds, ctx.Err()
	case errors.Is(mctx.Err(), context.DeadlineExceeded):
		return ds, errDumpTimeout
	case readErr != nil:
		return ds, readErr
	case werr != nil:
		return ds, werr
	case ds.RawBytes == 0:
		return ds, errEmptyDump
	}
	return ds, nil
}
