package migrate

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Dump failure classes (value-free; no credential ever appears in an error).
var (
	errDumpExit     = errors.New("dump command exited non-zero")
	errDumpTimeout  = errors.New("dump timed out")
	errDumpTooBig   = errors.New("dump exceeded the compressed size cap")
	errDumpCanceled = errors.New("dump canceled")
	errEmptyDump    = errors.New("dump produced no data")
	errBadFormat    = errors.New("dump does not have the expected format header")
)

// DumpResult is a completed, spooled dump. Path is the gzip file; SHA256 is the hex sha256 of the
// COMPRESSED bytes (what the hub independently hashes on the uploaded body).
type DumpResult struct {
	Path     string
	RawBytes int64
	GzBytes  int64
	SHA256   string
}

// dumpOne runs one Plan's dump with no shell: exec the pre-resolved docker path directly with the
// Go-built argv, stream stdout -> gzip -> (spool file + sha256), abort if the compressed size
// exceeds maxGz, and enforce a wall-clock timeout. It creates its own spool dir under spoolDir and
// removes it on ANY error; on success the caller owns Path and removes filepath.Dir(Path) after
// upload. p.Env must be non-nil and complete (a nil Env would inherit os.Environ()).
func dumpOne(ctx context.Context, dockerPath string, p Plan, spoolDir string, maxGz int64, timeout time.Duration) (DumpResult, error) {
	if len(p.Env) == 0 {
		return DumpResult{}, fmt.Errorf("refusing to run a dump with an empty child env")
	}
	if len(p.Argv) == 0 {
		return DumpResult{}, fmt.Errorf("empty dump argv")
	}

	itemDir, err := os.MkdirTemp(spoolDir, "tugra-migrate-*")
	if err != nil {
		return DumpResult{}, fmt.Errorf("spool dir: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(itemDir) }

	spoolPath := filepath.Join(itemDir, "artifact.gz")
	f, err := os.OpenFile(spoolPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		cleanup()
		return DumpResult{}, fmt.Errorf("spool file: %w", err)
	}

	base, cancelCause := context.WithCancelCause(ctx)
	defer cancelCause(nil)
	runCtx, cancelTimeout := context.WithTimeout(base, timeout)
	defer cancelTimeout()

	sha := sha256.New()
	cap := &capWriter{w: io.MultiWriter(f, sha), limit: maxGz, onOver: func() { cancelCause(errDumpTooBig) }}
	gz, _ := gzip.NewWriterLevel(cap, gzip.BestSpeed)
	rc := &rawCounter{w: gz}

	stderr := &ring{limit: 4 << 10}

	cmd := exec.CommandContext(runCtx, dockerPath, p.Argv[1:]...)
	cmd.Env = p.Env
	cmd.Stdin = nil
	cmd.Stdout = rc
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// On timeout/cancel/too-big this SIGKILLs the host-side `docker exec` CLIENT process group. The
	// in-container dumper (pg_dump/mysqldump) is NOT signalled — the daemon just drops the stream, so
	// it dies on EPIPE at its next write. A dumper blocked on a source-side lock can linger until the
	// lock is granted. `docker exec` exposes no --name handle to kill the exec'd pid portably; bounding
	// this (a server-side lock/statement timeout in the recipe) is tracked for S4b. The one temp file a
	// dump leaves in the container (Dragonfly's) is reaped by cleanupInContainer regardless.
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second

	runErr := cmd.Run()
	// Always flush+close the gzip trailer and the file before judging the result. A Sync or
	// Close error means the spooled bytes are not durably/completely on disk, so it is a stream
	// failure (caught here, BEFORE any upload is attempted with a truncated artifact).
	gzErr := gz.Close()
	syncErr := f.Sync()
	closeErr := f.Close()

	fail := func(e error) (DumpResult, error) {
		cleanup()
		return DumpResult{}, e
	}

	// Classify the failure, most-specific first.
	if cause := context.Cause(base); errors.Is(cause, errDumpTooBig) {
		return fail(errDumpTooBig)
	}
	if ctx.Err() != nil {
		return fail(errDumpCanceled) // parent canceled (signal)
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return fail(errDumpTimeout)
	}
	if runErr != nil {
		var ee *exec.ExitError
		if errors.As(runErr, &ee) {
			return fail(fmt.Errorf("%w (code %d)", errDumpExit, ee.ExitCode()))
		}
		return fail(fmt.Errorf("%w: %v", errDumpExit, runErr))
	}
	if gzErr != nil || cap.err != nil || syncErr != nil || closeErr != nil {
		return fail(fmt.Errorf("dump stream error"))
	}
	if rc.n == 0 {
		return fail(errEmptyDump)
	}
	if err := formatSanity(p.Engine, rc.head); err != nil {
		return fail(err)
	}

	return DumpResult{Path: spoolPath, RawBytes: rc.n, GzBytes: cap.n, SHA256: hex.EncodeToString(sha.Sum(nil))}, nil
}

// rawCounter counts uncompressed bytes and keeps the first bytes for a format sanity check.
type rawCounter struct {
	w    io.Writer
	n    int64
	head []byte
}

func (c *rawCounter) Write(p []byte) (int, error) {
	if len(c.head) < 16 {
		need := 16 - len(c.head)
		if need > len(p) {
			need = len(p)
		}
		c.head = append(c.head, p[:need]...)
	}
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// capWriter counts compressed bytes and, the instant the total would exceed limit, fires onOver
// (which kills the process group) and returns an error so the stream stops. A runaway dump can
// therefore never fill the disk.
type capWriter struct {
	w      io.Writer
	limit  int64
	n      int64
	err    error
	onOver func()
}

func (c *capWriter) Write(p []byte) (int, error) {
	if c.err != nil {
		return 0, c.err
	}
	if c.limit > 0 && c.n+int64(len(p)) > c.limit {
		c.err = errDumpTooBig
		if c.onOver != nil {
			c.onOver()
		}
		return 0, c.err
	}
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// ring is a bounded tail buffer for the dump's stderr (local diagnostics only; never sent to the
// hub or the JSON line, and only ever logged after scrub()).
type ring struct {
	limit int
	buf   []byte
}

func (r *ring) Write(p []byte) (int, error) {
	r.buf = append(r.buf, p...)
	if len(r.buf) > r.limit {
		r.buf = r.buf[len(r.buf)-r.limit:]
	}
	return len(p), nil
}

func (r *ring) String() string { return strings.TrimSpace(string(r.buf)) }

// formatSanity is a cheap, fail-closed guard against "exit 0 but garbage". It verifies magic bytes
// where they are known and verified; MYSQL/MARIADB/DRAGONFLY sanity is WARN-ONLY (returns nil)
// until confirmed against a real engine (open P0 VM test-debt).
func formatSanity(engine string, head []byte) error {
	switch engine {
	case "POSTGRES":
		if !hasPrefix(head, "PGDMP") {
			return fmt.Errorf("%w: POSTGRES custom archive magic missing", errBadFormat)
		}
	case "REDIS", "KEYDB":
		if !hasPrefix(head, "REDIS") {
			return fmt.Errorf("%w: RDB magic missing", errBadFormat)
		}
	}
	return nil
}

func hasPrefix(b []byte, s string) bool {
	return len(b) >= len(s) && string(b[:len(s)]) == s
}

// cleanupInContainer removes the only temp file a dump leaves inside the SOURCE container
// (Dragonfly's /data/tugra_backup.rdb, whose in-script rm is skipped if the docker client is
// killed). Best-effort, no shell, FRESH context (the item ctx is already dead by the time this
// runs), retried once. Package var so tests stub the daemon. REDIS/KEYDB SAVE writes the live
// /data/dump.rdb which must NOT be removed.
var cleanupInContainer = func(container, dockerPath string, env []string) {
	if !validContainer(container) || dockerPath == "" {
		return
	}
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, _, err := runDocker(ctx, []string{dockerPath, "exec", container, "rm", "-f", "/data/tugra_backup.rdb"}, env)
		cancel()
		if err == nil {
			return
		}
		time.Sleep(3 * time.Second) // SAVE may still be finishing inside the container
	}
}

// sweepStaleSpools removes leftover <prefix>* dirs older than 1h under dir (a SIGKILL/OOM residue),
// restricted to real directories we own, so it can never be steered at another path.
func sweepStaleSpools(dir, prefix string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-time.Hour)
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		p := filepath.Join(dir, e.Name())
		fi, err := os.Lstat(p)
		if err != nil || fi.Mode()&os.ModeSymlink != 0 || fi.ModTime().After(cutoff) {
			continue
		}
		if st, ok := fi.Sys().(*syscall.Stat_t); ok && uint64(st.Uid) != uint64(os.Geteuid()) {
			continue
		}
		_ = os.RemoveAll(p)
	}
}
