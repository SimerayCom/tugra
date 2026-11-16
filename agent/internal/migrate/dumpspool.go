package migrate

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// The DUMP SPOOL decouples the dump client from the uploader.
//
// A database server aborts a dump connection whose client does not read for net_write_timeout (MariaDB/MySQL: 60 s by default,
// and neither mariadb-dump nor mysqldump can raise it for their own session). The part pipeline reads the dump's stdout only as
// fast as it can upload parts, so a hub restart or a stalled link used to stop the reader, and the server cut the dump with
// "Error 2013: Lost connection to server during query". The spool puts a bounded ON-DISK queue between the two: a goroutine drains
// the client's stdout as fast as the client writes into SEGMENT files, the part reader consumes the segments in order and deletes
// each one as soon as it has been read, so the disk holds only the backlog, never the whole dump.
//
// Bounds: memory is one drain chunk (dumpSpoolChunk), never a segment. Disk is capped twice: by CapBytes (the sum of the live
// segment files) and by the free space of the spool directory minus MarginBytes. When either is reached the drain pauses and the
// client blocks on its pipe again (today's behaviour); the migrator logs that once. An empty backlog always lets one chunk
// through, so a tiny spool directory degrades to the old behaviour instead of deadlocking.

const (
	defaultDumpSpoolMiB     = 8192 // backlog cap in MiB when --dump-spool-mib is not given
	defaultDumpSpoolCap     = defaultDumpSpoolMiB * mib
	defaultDumpSpoolSegment = 64 * mib  // one segment file
	defaultDumpSpoolMargin  = 512 * mib // free space of the spool directory that is never used
	dumpSpoolChunk          = 256 << 10 // the drain's read buffer: the only memory the spool holds
	defaultDumpSpoolPoll    = 500 * time.Millisecond
	dumpSpoolPrefix         = "tugra-dumpspool-"
)

// DumpSpoolOpts configures one dump's spool. The zero value is the production default (a temp dir, 8 GiB, 64 MiB segments).
type DumpSpoolOpts struct {
	Dir         string // parent directory (an on-disk location; "" = os.TempDir()); a unique child is created in it and removed at the end
	CapBytes    int64  // largest sum of live segment files (<= 0: the default)
	SegBytes    int64  // segment size (<= 0: the default)
	MarginBytes int64  // free space of Dir that is left alone (< 0: none; 0: the default)
	Poll        time.Duration
	// Free reports the bytes available on the filesystem holding dir (package default: statfs). ok=false means unknown (no limit).
	Free func(dir string) (uint64, bool)
	// Logf receives the one line that says the drain paused.
	Logf func(string, ...any)
	// Exit, when set, is called once by the drain after the client's stdout ended cleanly (every read of the pipe is done, so waiting
	// for the process is safe). A non-nil result is a terminal error: the reader returns it at once instead of first serving the
	// whole backlog, so a dump that already failed does not upload gigabytes of a doomed stream.
	Exit func() error
	// Sync flushes a sealed segment (package default: (*os.File).Sync). It runs off the drain, so a slow disk never stops the reads.
	Sync func(*os.File) error
}

// dumpExitError carries the dump client's failed exit status through the reader; StreamDump unwraps it so the reported error is the
// client's own, exactly as when the status was read only after the last part.
type dumpExitError struct{ err error }

func (e *dumpExitError) Error() string { return e.err.Error() }
func (e *dumpExitError) Unwrap() error { return e.err }

// spoolFreeBytes is the default free-space probe.
func spoolFreeBytes(dir string) (uint64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, false
	}
	return uint64(st.Bavail) * uint64(st.Bsize), true //nolint:unconvert // field widths differ per OS
}

type spoolSeg struct {
	path    string
	wf      *os.File // the drain's handle (nil once sealed)
	rf      *os.File // the reader's handle (opened lazily)
	written int64    // bytes the drain has written (guarded by dumpSpool.mu)
	read    int64    // bytes the reader has consumed (reader only, mirrored under mu for accounting)
	sealed  bool     // no more bytes will be written (guarded by dumpSpool.mu)
}

// dumpSpool is an io.ReadCloser over a dump client's stdout with an on-disk buffer in between.
type dumpSpool struct {
	ctx         context.Context
	src         io.ReadCloser
	dir         string
	segBytes    int64
	capBytes    int64
	marginBytes int64
	poll        time.Duration
	free        func(string) (uint64, bool)
	logf        func(string, ...any)
	exit        func() error
	syncFn      func(*os.File) error
	afterOpen   func() // test hook: runs in Read between opening a segment and registering the handle

	mu      sync.Mutex
	segs    []*spoolSeg // live segments in stream order; the last may still be written
	cur     *spoolSeg   // the segment being written (also the last of segs), nil between segments
	nextID  int
	disk    int64 // sum of the written bytes of the live segments
	backlog int64 // bytes written and not yet read
	peak    int64 // the largest backlog seen
	paused  bool  // the "drain paused" line was logged
	eof     bool  // the client's stream ended cleanly (the last segment is sealed)
	err     error // the drain failed (a read error of the stream, or a write error of the spool)
	closed  bool

	avail chan struct{} // the drain -> the reader: something changed (buffered 1: a sticky wake-up)
	freed chan struct{} // the reader -> the drain: a segment was deleted
	quit  chan struct{}
	done  chan struct{} // the drain goroutine exited
	once  sync.Once
	syncs sync.WaitGroup // sealed segments being flushed and closed off the drain
}

// newDumpSpool creates the spool directory and starts draining src. The caller owns src through the returned spool: Close closes it.
func newDumpSpool(ctx context.Context, src io.ReadCloser, o DumpSpoolOpts) (*dumpSpool, error) {
	if o.Dir != "" {
		if err := os.MkdirAll(o.Dir, 0o700); err != nil {
			return nil, err
		}
	}
	dir, err := os.MkdirTemp(o.Dir, dumpSpoolPrefix+"*")
	if err != nil {
		return nil, err
	}
	s := &dumpSpool{ctx: ctx, src: src, dir: dir, segBytes: o.SegBytes, capBytes: o.CapBytes, marginBytes: o.MarginBytes,
		poll: o.Poll, free: o.Free, logf: o.Logf, exit: o.Exit, syncFn: o.Sync,
		avail: make(chan struct{}, 1), freed: make(chan struct{}, 1), quit: make(chan struct{}), done: make(chan struct{})}
	if s.segBytes <= 0 {
		s.segBytes = defaultDumpSpoolSegment
	}
	if s.capBytes <= 0 {
		s.capBytes = defaultDumpSpoolCap
	}
	switch {
	case s.marginBytes == 0:
		s.marginBytes = defaultDumpSpoolMargin
	case s.marginBytes < 0:
		s.marginBytes = 0
	}
	if s.poll <= 0 {
		s.poll = defaultDumpSpoolPoll
	}
	if s.free == nil {
		s.free = spoolFreeBytes
	}
	if s.syncFn == nil {
		s.syncFn = func(f *os.File) error { return f.Sync() }
	}
	if s.segBytes > s.capBytes { // a segment larger than the cap could never be sealed in time
		s.segBytes = s.capBytes
	}
	go s.drain()
	return s, nil
}

// PeakBacklog is the largest number of dump bytes that were on disk waiting for the uploader.
func (s *dumpSpool) PeakBacklog() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peak
}

func ping(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

// ---- the drain ----------------------------------------------------------------------------------------------------------

func (s *dumpSpool) drain() {
	defer close(s.done)
	buf := make([]byte, dumpSpoolChunk)
	for {
		n, rerr := s.src.Read(buf)
		if n > 0 {
			if err := s.write(buf[:n]); err != nil {
				s.fail(err)
				return
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				if err := s.sealCur(); err != nil {
					s.fail(err)
					return
				}
				s.syncs.Wait() // the flushes of the sealed segments have a say (an error) before the stream may end cleanly
				if s.exit != nil && s.ctx.Err() == nil {
					if xerr := s.exit(); xerr != nil && s.ctx.Err() == nil {
						s.fail(&dumpExitError{xerr})
						return
					}
				}
				s.mu.Lock()
				if s.err == nil {
					s.eof = true
				}
				s.mu.Unlock()
				ping(s.avail)
				return
			}
			s.fail(fmt.Errorf("reading the dump: %w", rerr))
			return
		}
	}
}

// fail records the drain's error unless the spool is being closed (the read error is then our own doing).
func (s *dumpSpool) fail(err error) {
	s.mu.Lock()
	if !s.closed && s.err == nil {
		s.err = err
	}
	s.mu.Unlock()
	ping(s.avail)
}

// write appends p to the segments, pausing while the backlog is at its limits.
func (s *dumpSpool) write(p []byte) error {
	for len(p) > 0 {
		if err := s.waitRoom(int64(len(p))); err != nil {
			return err
		}
		s.mu.Lock()
		seg := s.cur
		s.mu.Unlock()
		if seg != nil && seg.written >= s.segBytes { // only the drain writes `written`, so reading it here is safe
			if err := s.sealCur(); err != nil {
				return err
			}
			seg = nil
		}
		if seg == nil {
			var err error
			if seg, err = s.openSeg(); err != nil {
				return err
			}
		}
		room := s.segBytes - seg.written
		if room > int64(len(p)) {
			room = int64(len(p))
		}
		if _, err := seg.wf.Write(p[:room]); err != nil {
			return fmt.Errorf("the dump spool could not be written: %w", err)
		}
		s.mu.Lock()
		seg.written += room
		s.disk += room
		s.backlog += room
		if s.backlog > s.peak {
			s.peak = s.backlog
		}
		s.mu.Unlock()
		ping(s.avail)
		p = p[room:]
	}
	return nil
}

func (s *dumpSpool) openSeg() (*spoolSeg, error) {
	path := filepath.Join(s.dir, fmt.Sprintf("seg-%08d", s.nextID))
	s.nextID++
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, fmt.Errorf("the dump spool could not be written: %w", err)
	}
	seg := &spoolSeg{path: path, wf: f}
	s.mu.Lock()
	s.segs = append(s.segs, seg)
	s.cur = seg
	s.mu.Unlock()
	return seg, nil
}

// sealCur ends the segment being written and hands it to the reader as complete. The segment is flushed and closed by a
// goroutine of its own (its pages become clean and reclaimable, which matters under a container memory cap): the drain must keep
// reading the client meanwhile, a slow or contended disk must not stall it for the length of one fsync. A flush error fails the
// spool (the reader returns it); the reader may delete the file before the flush ends, which is harmless.
func (s *dumpSpool) sealCur() error {
	s.mu.Lock()
	seg := s.cur
	s.cur = nil
	s.mu.Unlock()
	if seg == nil {
		return nil
	}
	wf := seg.wf
	s.syncs.Add(1)
	go func() {
		defer s.syncs.Done()
		serr := s.syncFn(wf)
		cerr := wf.Close()
		switch {
		case serr != nil:
			s.fail(fmt.Errorf("the dump spool could not be written: %w", serr))
		case cerr != nil:
			s.fail(fmt.Errorf("the dump spool could not be written: %w", cerr))
		}
	}()
	s.mu.Lock()
	seg.wf = nil
	seg.sealed = true
	s.mu.Unlock()
	ping(s.avail)
	return nil
}

// waitRoom blocks while n more bytes would take the spool past its cap or into the free-space margin. With nothing on disk it
// returns at once (a spool that can hold nothing must not deadlock: the pipe then behaves as it always did).
func (s *dumpSpool) waitRoom(n int64) error {
	for {
		s.mu.Lock()
		disk, closed, ferr := s.disk, s.closed, s.err
		s.mu.Unlock()
		if closed {
			return io.ErrClosedPipe
		}
		if ferr != nil { // a flush of a sealed segment failed: stop draining
			return ferr
		}
		if err := s.ctx.Err(); err != nil {
			return err
		}
		if disk == 0 {
			return nil
		}
		full := disk+n > s.capBytes
		if !full {
			if free, ok := s.free(s.dir); ok && free < uint64(s.marginBytes)+uint64(n) {
				full = true
			}
		}
		if !full {
			return nil
		}
		// Hand the reader the segment being written: it can only delete a sealed one, and without that the backlog would never shrink.
		if err := s.sealCur(); err != nil {
			return err
		}
		s.mu.Lock()
		first := !s.paused
		s.paused = true
		s.mu.Unlock()
		if first && s.logf != nil {
			s.logf("dump spool: %d MiB of the dump wait on disk (limit %d MiB, or the free space of the spool directory); reading from the dump client pauses until the upload catches up",
				disk>>20, s.capBytes>>20)
		}
		t := time.NewTimer(s.poll)
		select {
		case <-s.freed:
		case <-t.C:
		case <-s.quit:
		case <-s.ctx.Done():
		}
		t.Stop()
	}
}

// ---- the reader ---------------------------------------------------------------------------------------------------------

// Read serves the dump in order. It blocks until bytes are available, the stream ended (io.EOF), the drain failed or the spool
// was closed or its context cancelled.
func (s *dumpSpool) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for {
		if err := s.ctx.Err(); err != nil {
			return 0, err
		}
		s.mu.Lock()
		switch {
		case s.closed:
			s.mu.Unlock()
			return 0, io.ErrClosedPipe
		case s.err != nil:
			err := s.err
			s.mu.Unlock()
			return 0, err
		}
		var seg *spoolSeg
		var avail int64
		if len(s.segs) > 0 {
			seg = s.segs[0]
			avail = seg.written - seg.read
			if avail <= 0 && seg.sealed { // fully consumed: delete it at once
				s.segs = s.segs[1:]
				s.disk -= seg.written
				rf := seg.rf
				s.mu.Unlock()
				if rf != nil {
					_ = rf.Close()
				}
				_ = os.Remove(seg.path)
				ping(s.freed)
				continue
			}
		} else if s.eof {
			s.mu.Unlock()
			return 0, io.EOF
		}
		s.mu.Unlock()
		if avail > 0 {
			if seg.rf == nil {
				f, err := os.Open(seg.path)
				if err != nil {
					return 0, fmt.Errorf("the dump spool could not be read: %w", err)
				}
				if s.afterOpen != nil {
					s.afterOpen()
				}
				s.mu.Lock()
				if s.closed { // Close has already swept the handles: this one would never be closed
					s.mu.Unlock()
					_ = f.Close()
					return 0, io.ErrClosedPipe
				}
				seg.rf = f
				s.mu.Unlock()
			}
			if int64(len(p)) > avail {
				p = p[:avail]
			}
			n, err := seg.rf.Read(p)
			if n > 0 {
				s.mu.Lock()
				seg.read += int64(n)
				s.backlog -= int64(n)
				s.mu.Unlock()
				return n, nil
			}
			if err != nil && err != io.EOF {
				return 0, fmt.Errorf("the dump spool could not be read: %w", err)
			}
			continue
		}
		select {
		case <-s.avail:
		case <-s.ctx.Done():
		case <-s.quit:
		}
	}
}

// Close stops the drain, closes the client's stdout and removes every segment and the spool directory. It is safe to call twice,
// and it returns only after the drain no longer reads from the client (the caller may then wait for the process).
func (s *dumpSpool) Close() error {
	s.once.Do(func() {
		s.mu.Lock()
		s.closed = true
		s.mu.Unlock()
		close(s.quit)
		_ = s.src.Close() // unblocks a drain that is reading
		<-s.done
		s.syncs.Wait()
		s.mu.Lock()
		for _, seg := range s.segs {
			if seg.wf != nil {
				_ = seg.wf.Close()
			}
			if seg.rf != nil {
				_ = seg.rf.Close()
			}
		}
		s.segs, s.cur, s.disk = nil, nil, 0
		s.mu.Unlock()
		_ = os.RemoveAll(s.dir)
	})
	return nil
}

var _ io.ReadCloser = (*dumpSpool)(nil)
