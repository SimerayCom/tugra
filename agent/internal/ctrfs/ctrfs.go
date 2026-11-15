// Package ctrfs is the file manager's driver for the LIVE container filesystem (/app, /etc, ...). It uses the
// docker CLI only — `docker cp` (daemon-side: no code runs in the target, so it works on stopped and distroless
// containers) for stat/list/read/write/mkdir, and a fixed-argv `docker exec` for rename/chmod/delete. Nothing is
// ever extracted to the agent's disk: the tar streams are parsed header-by-header (stdlib archive/tar) with hard
// byte/time/entry budgets, and the helper container of the volume path is not used (and never gets docker.sock).
//
// Every argument that reaches the CLI starts with "/" (paths) or an alphanumeric (the validated container name), so
// nothing can be parsed as an option, and no shell is involved anywhere.
package ctrfs

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	maxPathLen   = 4096
	maxCmdOutput = 4 << 10 // exec / cp stderr + stdout capture
	maxErrMsg    = 200     // stderr characters surfaced in a `failed` message
)

// Listing budgets (vars so tests can shrink them): whichever is hit first ends the scan with truncated=true.
var (
	maxListEntries = 10000            // same cap as the volume listing
	listMaxHeaders = 50000            // headers scanned before giving up on a huge tree
	listMaxWall    = 5 * time.Second  // wall-clock budget for one listing
	listMaxBytes   = int64(128 << 20) // bytes of tar stream skipped over before giving up
)

var nameRe = regexp.MustCompile(`^tugra_[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$`)

// ValidateName accepts only Tugra-managed container names (tugra_<id>[-service-N]) and never the transient
// rolling-update names (__rollout / __prev): a request must not act on a container the deploy is about to replace.
func ValidateName(name string) error {
	if !nameRe.MatchString(name) {
		return errors.New("invalid container name")
	}
	if strings.HasSuffix(name, "__rollout") || strings.HasSuffix(name, "__prev") {
		return errors.New("transient container")
	}
	return nil
}

// ValidatePath requires a clean absolute in-container path outside /proc, /sys and /dev (reads included).
// Mutations additionally refuse "/".
func ValidatePath(p string, mutating bool) error {
	if len(p) == 0 || len(p) > maxPathLen || p[0] != '/' {
		return errors.New("container path must be absolute")
	}
	for i := 0; i < len(p); i++ {
		if p[i] == 0 || p[i] < 0x20 || p[i] == 0x7f || p[i] == '\\' {
			return errors.New("path contains a forbidden character")
		}
	}
	if path.Clean(p) != p {
		return errors.New("path must be clean")
	}
	for _, d := range []string{"/proc", "/sys", "/dev"} {
		if p == d || strings.HasPrefix(p, d+"/") {
			return errors.New("this location is not browsable")
		}
	}
	if mutating && p == "/" {
		return errors.New("refusing to modify the container root")
	}
	return nil
}

func bad(format string, a ...any) error {
	return &fsd.Error{Code: fsd.CodeBadRequest, Msg: fmt.Sprintf(format, a...)}
}
func typed(code, msg string) error { return &fsd.Error{Code: code, Msg: msg} }

// ── process seam ─────────────────────────────────────────────────────────────────────────────────────────────

// proc is one running docker CLI invocation.
type proc struct {
	Stdout io.ReadCloser
	// Wait reaps the process; its error may expose ExitCode() int (os/exec's *ExitError does).
	Wait   func() error
	Stderr func() string
	Kill   func()
}

// start launches `docker args...`. Package var so tests drive the CLI without a daemon.
var start = func(ctx context.Context, stdin io.Reader, args ...string) (*proc, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stdin = stdin
	cmd.WaitDelay = 5 * time.Second
	eb := &capBuffer{max: maxCmdOutput}
	cmd.Stderr = eb
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &proc{
		Stdout: out,
		Wait:   cmd.Wait,
		Stderr: func() string { return strings.TrimSpace(eb.String()) },
		Kill: func() {
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
		},
	}, nil
}

// capBuffer keeps at most max bytes and silently discards the rest.
type capBuffer struct {
	mu  sync.Mutex
	max int
	buf bytes.Buffer
}

func (c *capBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}

func (c *capBuffer) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// mapDocker turns a failed docker invocation into a typed error. The raw stderr never reaches the hub beyond a
// short, control-stripped excerpt in the generic `failed` case; the full detail is logged locally.
func mapDocker(stderr string, err error) error {
	low := strings.ToLower(stderr)
	switch {
	case strings.Contains(low, "no such container"), strings.Contains(low, "is not running"), strings.Contains(low, "is restarting"), strings.Contains(low, "is paused"):
		return typed(fsd.CodeNotRunning, "the container is not available")
	case strings.Contains(low, "could not find the file"), strings.Contains(low, "no such file or directory"), strings.Contains(low, "no such file"):
		return typed(fsd.CodeNotFound, "no such file or directory")
	case strings.Contains(low, "read-only file system"), strings.Contains(low, "is read-only"):
		return typed(fsd.CodeReadOnly, "read-only file system")
	case strings.Contains(low, "permission denied"), strings.Contains(low, "operation not permitted"):
		return typed(fsd.CodeDenied, "permission denied")
	case strings.Contains(low, "not a directory"):
		return typed(fsd.CodeNotDir, "not a directory")
	case strings.Contains(low, "is a directory"):
		return typed(fsd.CodeIsDir, "is a directory")
	case strings.Contains(low, "directory not empty"):
		return typed(fsd.CodeNotEmpty, "directory not empty")
	}
	fmt.Fprintf(os.Stderr, "ctrfs: docker failed: %v: %s\n", err, stderr)
	msg := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.TrimSpace(stderr))
	if len(msg) > maxErrMsg {
		msg = msg[:maxErrMsg]
	}
	if msg == "" {
		msg = "container filesystem operation failed"
	}
	return typed(fsd.CodeFailed, msg)
}

type exitCoder interface{ ExitCode() int }

// finish reaps p after the caller is done reading and maps a failure. `killed` means WE ended it early on purpose.
func finish(ctx context.Context, p *proc, killed bool) error {
	err := p.Wait()
	if err == nil || killed {
		return nil
	}
	if ctx.Err() != nil {
		return typed(fsd.CodeFailed, "file operation timed out")
	}
	return mapDocker(p.Stderr(), err)
}

// ── tar helpers ──────────────────────────────────────────────────────────────────────────────────────────────

func fsType(h *tar.Header) string {
	switch h.Typeflag {
	case tar.TypeDir:
		return "dir"
	case tar.TypeReg, tar.TypeRegA:
		return "file"
	case tar.TypeSymlink:
		return "symlink"
	default:
		return "other"
	}
}

func statFromHeader(name string, h *tar.Header) protocol.FsStat {
	st := protocol.FsStat{
		Name:    name,
		Type:    fsType(h),
		Size:    h.Size,
		Mode:    fmt.Sprintf("%04o", uint32(h.Mode)&0o777),
		Mtime:   h.ModTime.Unix(),
		MtimeNs: h.ModTime.UnixNano(),
		UID:     h.Uid,
		GID:     h.Gid,
		Uname:   h.Uname,
		Gname:   h.Gname,
	}
	if st.Type != "file" {
		st.Size = 0 // a dir/link/special header's size field is not a content size
	}
	if h.Typeflag == tar.TypeSymlink {
		st.LinkTarget = h.Linkname
	}
	st.Etag = fmt.Sprintf("%d-%d", st.Size, st.MtimeNs)
	return st
}

// firstHeader runs `docker cp NAME:/p -` and returns the first tar header plus a function that kills the CLI and
// reaps it. The body is not read beyond the header unless the caller continues with the returned reader.
func firstHeader(ctx context.Context, name, p string) (*tar.Header, *tar.Reader, *proc, context.CancelFunc, error) {
	cctx, cancel := context.WithCancel(ctx)
	pr, err := start(cctx, nil, "cp", name+":"+p, "-")
	if err != nil {
		cancel()
		return nil, nil, nil, nil, typed(fsd.CodeFailed, "could not run docker")
	}
	tr := tar.NewReader(pr.Stdout)
	h, err := tr.Next()
	if err != nil {
		pr.Kill()
		cancel()
		werr := finish(ctx, pr, false)
		if werr != nil {
			return nil, nil, nil, nil, werr
		}
		if errors.Is(err, io.EOF) {
			return nil, nil, nil, nil, typed(fsd.CodeNotFound, "no such file or directory")
		}
		return nil, nil, nil, nil, typed(fsd.CodeFailed, "unreadable archive from docker")
	}
	return h, tr, pr, cancel, nil
}

// kill ends the CLI early (we have what we need) and reaps it.
func kill(ctx context.Context, pr *proc, cancel context.CancelFunc) {
	pr.Kill()
	cancel()
	_ = finish(ctx, pr, true)
}

// ── Stat ─────────────────────────────────────────────────────────────────────────────────────────────────────

// Stat reports one container path from its FIRST tar header only (then kills the CLI). A symlink is reported,
// never dereferenced.
func Stat(ctx context.Context, name, p string) (protocol.FsStat, error) {
	if err := ValidateName(name); err != nil {
		return protocol.FsStat{}, bad("%s", err.Error())
	}
	if err := ValidatePath(p, false); err != nil {
		return protocol.FsStat{}, bad("%s", err.Error())
	}
	h, _, pr, cancel, err := firstHeader(ctx, name, p)
	if err != nil {
		return protocol.FsStat{}, err
	}
	defer kill(ctx, pr, cancel)
	base := path.Base(p)
	if p == "/" {
		base = ""
	}
	return statFromHeader(base, h), nil
}

// ── List ─────────────────────────────────────────────────────────────────────────────────────────────────────

// norm turns a tar entry name into a clean, root-relative path ("" is the archive root). Names carrying a ".."
// segment, a NUL or a backslash are rejected (ok=false): they are only ever DISPLAYED, never written anywhere, but
// a hostile image must not be able to forge a sibling.
func norm(name string) (string, bool) {
	if strings.ContainsRune(name, 0) || strings.Contains(name, "\\") {
		return "", false
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == ".." {
			return "", false
		}
	}
	return strings.TrimPrefix(path.Clean("/"+name), "/"), true
}

// List returns the DIRECT children of dir by parsing tar headers only (never extracting). It is honest-partial for
// huge trees: it stops at 50,000 headers, 5 s or 128 MiB of stream (whichever comes first) and reports
// truncated=true. The archive's naming differs for "/" and for ordinary directories, so the parser takes the first
// header as the directory itself and keeps entries exactly one component below it.
func List(ctx context.Context, name, dir string) ([]protocol.FsEntry, bool, error) {
	if err := ValidateName(name); err != nil {
		return nil, false, bad("%s", err.Error())
	}
	if err := ValidatePath(dir, false); err != nil {
		return nil, false, bad("%s", err.Error())
	}
	wctx, wcancel := context.WithTimeout(ctx, listMaxWall)
	defer wcancel()
	cctx, cancel := context.WithCancel(wctx)
	pr, err := start(cctx, nil, "cp", name+":"+dir, "-")
	if err != nil {
		cancel()
		return nil, false, typed(fsd.CodeFailed, "could not run docker")
	}
	defer func() {
		pr.Kill()
		cancel()
		_ = finish(ctx, pr, true)
	}()
	tr := tar.NewReader(io.LimitReader(pr.Stdout, listMaxBytes))

	first, err := tr.Next()
	if err != nil {
		pr.Kill()
		if werr := finish(ctx, pr, false); werr != nil {
			return nil, false, werr
		}
		if errors.Is(err, io.EOF) {
			return nil, false, typed(fsd.CodeNotFound, "no such file or directory")
		}
		return nil, false, typed(fsd.CodeFailed, "unreadable archive from docker")
	}
	if first.Typeflag != tar.TypeDir {
		return nil, false, typed(fsd.CodeNotDir, "not a directory")
	}
	rootNorm, ok := norm(first.Name)
	if !ok {
		return nil, false, typed(fsd.CodeFailed, "unexpected archive layout")
	}

	out := make([]protocol.FsEntry, 0, 64)
	seen := map[string]bool{}
	scanned := 1
	truncated := false
	for {
		if scanned >= listMaxHeaders {
			truncated = true
			break
		}
		h, err := tr.Next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			// Budget exhausted mid-stream (byte limit / wall clock / killed): what we have is a partial listing.
			truncated = true
			break
		}
		scanned++
		n, ok := norm(h.Name)
		if !ok {
			continue
		}
		var rel string
		switch {
		case rootNorm == "":
			rel = n
		case strings.HasPrefix(n, rootNorm+"/"):
			rel = n[len(rootNorm)+1:]
		default:
			continue
		}
		if rel == "" || strings.Contains(rel, "/") || seen[rel] {
			continue
		}
		if len(out) >= maxListEntries {
			truncated = true
			break
		}
		seen[rel] = true
		e := protocol.FsEntry{Name: rel, Type: fsType(h), Mode: h.FileInfo().Mode().Perm().String(), Mtime: h.ModTime.Unix()}
		if e.Type == "file" {
			e.Size = h.Size
		}
		out = append(out, e)
	}
	if wctx.Err() != nil && ctx.Err() == nil {
		truncated = true // our own 5 s budget, not the caller's deadline
	}
	return out, truncated, nil
}

// ── ReadTo ───────────────────────────────────────────────────────────────────────────────────────────────────

// ReadTo streams exactly `size` bytes of a regular file to w. The first header must be a regular file of that size
// (else not_regular / is_dir / changed); the body is copied through a LimitReader and the CLI is killed as soon as
// the bytes are out. Nothing touches the agent's disk.
func ReadTo(ctx context.Context, name, p string, size int64, w io.Writer) error {
	if err := ValidateName(name); err != nil {
		return bad("%s", err.Error())
	}
	if err := ValidatePath(p, false); err != nil {
		return bad("%s", err.Error())
	}
	if size < 0 {
		return bad("size is required")
	}
	h, tr, pr, cancel, err := firstHeader(ctx, name, p)
	if err != nil {
		return err
	}
	defer kill(ctx, pr, cancel)
	switch h.Typeflag {
	case tar.TypeReg, tar.TypeRegA:
	case tar.TypeDir:
		return typed(fsd.CodeIsDir, "is a directory")
	default:
		return typed(fsd.CodeNotRegular, "not a regular file")
	}
	if h.Size != size {
		return typed(fsd.CodeChanged, "file size changed")
	}
	n, cerr := io.Copy(w, io.LimitReader(tr, size))
	if cerr != nil {
		if ctx.Err() != nil {
			return typed(fsd.CodeFailed, "file operation timed out")
		}
		return typed(fsd.CodeFailed, "read failed")
	}
	if n != size {
		return typed(fsd.CodeChanged, "file shrank while reading")
	}
	return nil
}
