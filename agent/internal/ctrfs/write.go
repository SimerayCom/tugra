package ctrfs

import (
	"archive/tar"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// WriteOpts configures Write. Mode applies only when HasMode.
type WriteOpts struct {
	Mode      fs.FileMode
	HasMode   bool
	Overwrite bool
	Size      int64
	Sha256    string
	IfMatch   string
}

// WriteResult is what a successful write reports.
type WriteResult struct {
	Bytes   int64
	Sha256  string
	Etag    string
	Created bool
}

// StageDir is where an incoming body is held (0600) while its size and SHA-256 are verified, BEFORE the container
// is touched. It lives on the agent's own persisted volume; main sweeps it at startup.
var StageDir = func() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".tugra", "fsx")
}()

// stageHeadroom is the free space that must remain on the agent after staging an upload.
const stageHeadroom = 64 << 20

var stageRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// SweepStage removes staged files older than maxAge (best effort). Called at agent startup.
func SweepStage(maxAge time.Duration) int {
	entries, err := os.ReadDir(StageDir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !stageRe.MatchString(e.Name()) || !e.Type().IsRegular() {
			continue
		}
		if info, ierr := e.Info(); ierr == nil && time.Since(info.ModTime()) > maxAge {
			if os.Remove(filepath.Join(StageDir, e.Name())) == nil {
				n++
			}
		}
	}
	return n
}

func randName() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// stage copies exactly size bytes of src into a private temp file, verifying the SHA-256 and that src has nothing
// more. It returns the open (rewound) file and its path; the caller closes and removes it.
func stage(src io.Reader, size int64, wantSha string) (*os.File, string, error) {
	if err := os.MkdirAll(StageDir, 0o700); err != nil {
		return nil, "", typed(fsd.CodeFailed, "cannot stage the upload")
	}
	if free, ok := freeBytes(StageDir); ok && free < uint64(size)+stageHeadroom {
		return nil, "", typed(fsd.CodeNoSpace, "not enough free space on the agent to stage the upload")
	}
	p := filepath.Join(StageDir, randName())
	f, err := os.OpenFile(p, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, "", typed(fsd.CodeFailed, "cannot stage the upload")
	}
	fail := func(e error) (*os.File, string, error) {
		_ = f.Close()
		_ = os.Remove(p)
		return nil, "", e
	}
	h := sha256.New()
	n, cerr := io.CopyN(io.MultiWriter(f, h), src, size)
	if cerr != nil {
		if errors.Is(cerr, io.EOF) {
			return fail(bad("body shorter than declared size (%d of %d)", n, size))
		}
		if errors.Is(cerr, syscall.ENOSPC) {
			return fail(typed(fsd.CodeNoSpace, "not enough free space on the agent to stage the upload"))
		}
		return fail(typed(fsd.CodeFailed, "could not read the upload"))
	}
	var extra [1]byte
	if m, _ := src.Read(extra[:]); m > 0 {
		return fail(bad("body longer than declared size"))
	}
	if wantSha != "" && !strings.EqualFold(wantSha, hex.EncodeToString(h.Sum(nil))) {
		return fail(typed(fsd.CodeIntegrity, "content hash mismatch"))
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return fail(typed(fsd.CodeFailed, "cannot stage the upload"))
	}
	return f, p, nil
}

// run executes `docker args...` to completion with stdin, returning typed errors.
func run(ctx context.Context, stdin io.Reader, args ...string) (string, error) {
	pr, err := start(ctx, stdin, args...)
	if err != nil {
		return "", typed(fsd.CodeFailed, "could not run docker")
	}
	var out capBuffer
	out.max = maxCmdOutput
	_, _ = io.Copy(&out, pr.Stdout)
	werr := pr.Wait()
	if werr != nil {
		if ctx.Err() != nil {
			return out.String(), typed(fsd.CodeFailed, "file operation timed out")
		}
		return out.String(), mapDocker(pr.Stderr(), werr)
	}
	return out.String(), nil
}

// putTar pipes ONE tar entry we build ourselves into `docker cp -a - NAME:/parent`. The entry name is a validated
// basename (no "/"), so the archive can never place anything outside `parent`, and `-a` keeps our uid/gid.
func putTar(ctx context.Context, name, parent string, hdr *tar.Header, body io.Reader) error {
	pr, pw := io.Pipe()
	go func() {
		tw := tar.NewWriter(pw)
		err := tw.WriteHeader(hdr)
		if err == nil && body != nil && hdr.Size > 0 {
			_, err = io.Copy(tw, io.LimitReader(body, hdr.Size))
		}
		if err == nil {
			err = tw.Close()
		}
		_ = pw.CloseWithError(err)
	}()
	_, err := run(ctx, pr, "cp", "-a", "-", name+":"+parent)
	_ = pr.CloseWithError(err) // unblock the writer if docker exited early
	return err
}

func baseName(p string) (string, error) {
	b := path.Base(p)
	if b == "" || b == "/" || b == "." || strings.Contains(b, "/") {
		return "", bad("invalid file name")
	}
	return b, nil
}

// Write replaces or creates one regular file. Preflight stats the target and its parent (a symlink target is
// refused, a directory is `is_dir`, an existing file without overwrite is `exists`, a stale IfMatch is `changed`);
// the body is staged and verified; ONE tar entry (name = basename, size, mode, owner copied from the existing file or
// the parent) is then extracted in place. It is NOT atomic (the daemon extracts in place) and the result is
// ephemeral (lost when the container is recreated).
func Write(ctx context.Context, name, p string, o WriteOpts, src io.Reader) (WriteResult, error) {
	var zero WriteResult
	if err := ValidateName(name); err != nil {
		return zero, bad("%s", err.Error())
	}
	if err := ValidatePath(p, true); err != nil {
		return zero, bad("%s", err.Error())
	}
	if o.Size < 0 {
		return zero, bad("size is required")
	}
	base, err := baseName(p)
	if err != nil {
		return zero, err
	}
	parent := path.Dir(p)

	var existing *protocol.FsStat
	if st, serr := Stat(ctx, name, p); serr == nil {
		existing = &st
		switch {
		case st.Type == "dir":
			return zero, typed(fsd.CodeIsDir, "is a directory")
		case st.Type != "file":
			return zero, typed(fsd.CodeNotRegular, "not a regular file")
		case !o.Overwrite:
			return zero, typed(fsd.CodeExists, "already exists")
		}
		if o.IfMatch != "" && st.Etag != o.IfMatch {
			return zero, typed(fsd.CodeChanged, "file changed since it was read")
		}
	} else if te := (*fsd.Error)(nil); !errors.As(serr, &te) || te.Code != fsd.CodeNotFound {
		return zero, serr
	} else if o.IfMatch != "" {
		return zero, typed(fsd.CodeChanged, "file no longer exists")
	}
	pst, err := statDir(ctx, name, parent)
	if err != nil {
		return zero, err
	}

	// Verify the whole body BEFORE the container sees a byte.
	f, sp, err := stage(src, o.Size, o.Sha256)
	if err != nil {
		return zero, err
	}
	defer func() {
		_ = f.Close()
		_ = os.Remove(sp)
	}()
	sum := o.Sha256
	if sum == "" {
		h := sha256.New()
		_, _ = io.Copy(h, f)
		_, _ = f.Seek(0, io.SeekStart)
		sum = hex.EncodeToString(h.Sum(nil))
	}

	mode := fs.FileMode(0o644)
	uid, gid := pst.UID, pst.GID
	switch {
	case o.HasMode:
		mode = o.Mode
	case existing != nil:
		var m uint32
		_, _ = fmt.Sscanf(existing.Mode, "%o", &m)
		mode = fs.FileMode(m & 0o777)
	}
	if existing != nil {
		uid, gid = existing.UID, existing.GID
	}
	hdr := &tar.Header{Typeflag: tar.TypeReg, Name: base, Size: o.Size, Mode: int64(mode.Perm()), Uid: uid, Gid: gid, ModTime: time.Now()}
	if err := putTar(ctx, name, parent, hdr, f); err != nil {
		return zero, err
	}
	res := WriteResult{Bytes: o.Size, Sha256: sum, Created: existing == nil}
	if st, serr := Stat(ctx, name, p); serr == nil {
		res.Etag = st.Etag
	} else {
		res.Etag = fmt.Sprintf("%d-%d", o.Size, time.Now().UnixNano())
	}
	return res, nil
}

// statDir stats p and requires it to be a directory, following ONE symlink the way List does: docker cp answers a
// symlinked directory (/app -> /usr/src/app, usr-merged /bin) with a bare symlink header, and "<p>/." makes it resolve
// the link. A link that does not lead to a directory (a file, a dangling link) is not_dir. The caller keeps the
// logical, unresolved path: docker cp resolves a symlinked destination itself.
func statDir(ctx context.Context, name, p string) (protocol.FsStat, error) {
	st, err := Stat(ctx, name, p)
	if err != nil {
		return st, err
	}
	if st.Type == "symlink" {
		h, _, pr, cancel, herr := firstHeader(ctx, name, strings.TrimSuffix(p, "/")+"/.")
		if herr != nil {
			var te *fsd.Error
			if errors.As(herr, &te) && te.Code == fsd.CodeNotFound {
				return st, typed(fsd.CodeNotDir, "not a directory")
			}
			return st, herr
		}
		defer kill(ctx, pr, cancel)
		st = statFromHeader(st.Name, h)
	}
	if st.Type != "dir" {
		return st, typed(fsd.CodeNotDir, "not a directory")
	}
	return st, nil
}

// Mkdir creates a directory with one tar dir entry per missing level, each owned like its nearest existing ancestor.
func Mkdir(ctx context.Context, name, p string, mode fs.FileMode, parents bool) error {
	if err := ValidateName(name); err != nil {
		return bad("%s", err.Error())
	}
	if err := ValidatePath(p, true); err != nil {
		return bad("%s", err.Error())
	}
	if mode > 0o777 {
		return bad("setuid, setgid and sticky bits are not allowed")
	}
	if st, err := Stat(ctx, name, p); err == nil {
		if parents && st.Type == "dir" {
			return nil
		}
		return typed(fsd.CodeExists, "already exists")
	} else if te := (*fsd.Error)(nil); !errors.As(err, &te) || te.Code != fsd.CodeNotFound {
		return err
	}
	// Find the deepest existing ancestor (stat from the root down).
	segs := strings.Split(strings.TrimPrefix(p, "/"), "/")
	existingUpTo := 0 // number of leading segments that exist
	cur := "/"
	ancestor, err := Stat(ctx, name, "/")
	if err != nil {
		return err
	}
	for i, s := range segs {
		next := path.Join(cur, s)
		st, serr := statDir(ctx, name, next)
		if serr != nil {
			var te *fsd.Error
			if errors.As(serr, &te) && te.Code == fsd.CodeNotFound {
				break
			}
			return serr
		}
		ancestor, cur, existingUpTo = st, next, i+1
	}
	if !parents && existingUpTo != len(segs)-1 {
		return typed(fsd.CodeNotFound, "parent directory does not exist")
	}
	for i := existingUpTo; i < len(segs); i++ {
		lvl := fs.FileMode(0o755) // intermediate levels stay traversable; only the leaf takes the requested mode
		if i == len(segs)-1 {
			lvl = mode
		}
		hdr := &tar.Header{Typeflag: tar.TypeDir, Name: segs[i] + "/", Mode: int64(lvl.Perm()), Uid: ancestor.UID, Gid: ancestor.GID, ModTime: time.Now()}
		if err := putTar(ctx, name, cur, hdr, nil); err != nil {
			return err
		}
		cur = path.Join(cur, segs[i])
	}
	return nil
}

// ExecOp runs rename / chmod / delete through a fixed-argv `docker exec` (no -i, -t, --user, --privileged or env, no
// shell) as the image's default user. A missing binary (exit 126/127) is `no_binary`; a stopped container is
// `not_running`. a is the path (rename: the source), b the rename destination.
func ExecOp(ctx context.Context, name, op, a, b, mode string, recursive bool) error {
	if err := ValidateName(name); err != nil {
		return bad("%s", err.Error())
	}
	if err := ValidatePath(a, true); err != nil {
		return bad("%s", err.Error())
	}
	var argv []string
	switch op {
	case "rename":
		if err := ValidatePath(b, true); err != nil {
			return bad("%s", err.Error())
		}
		if a == b || strings.HasPrefix(b, a+"/") {
			return bad("cannot move an entry into itself")
		}
		if _, err := Stat(ctx, name, a); err != nil {
			return err
		}
		if _, err := Stat(ctx, name, b); err == nil {
			return typed(fsd.CodeExists, "destination already exists") // never let `mv` move INTO an existing dir
		} else if te := (*fsd.Error)(nil); !errors.As(err, &te) || te.Code != fsd.CodeNotFound {
			return err
		}
		argv = []string{"mv", "--", a, b}
	case "chmod":
		m, err := parseMode(mode)
		if err != nil {
			return bad("%s", err.Error())
		}
		if _, err := Stat(ctx, name, a); err != nil {
			return err
		}
		argv = []string{"chmod", fmt.Sprintf("%04o", uint32(m)), "--", a}
	case "delete":
		st, err := Stat(ctx, name, a)
		if err != nil {
			return err
		}
		switch {
		case st.Type != "dir":
			argv = []string{"rm", "--", a}
		case recursive:
			argv = []string{"rm", "-r", "--", a}
		default:
			argv = []string{"rmdir", "--", a}
		}
	default:
		return bad("unsupported op")
	}
	full := append([]string{"exec", "-w", "/", name}, argv...)
	pr, err := start(ctx, nil, full...)
	if err != nil {
		return typed(fsd.CodeFailed, "could not run docker")
	}
	var out capBuffer
	out.max = maxCmdOutput
	_, _ = io.Copy(&out, pr.Stdout)
	werr := pr.Wait()
	if werr == nil {
		return nil
	}
	if ctx.Err() != nil {
		return typed(fsd.CodeFailed, "file operation timed out")
	}
	var ec exitCoder
	if errors.As(werr, &ec) {
		switch ec.ExitCode() {
		case 126, 127:
			return typed(fsd.CodeNoBinary, "the container image does not include the tool for this operation")
		}
	}
	// docker exec runs the tool; its own message (e.g. rmdir: not empty) arrives on stderr.
	e := mapDocker(pr.Stderr(), werr)
	var te *fsd.Error
	if errors.As(e, &te) && te.Code == fsd.CodeFailed && strings.Contains(strings.ToLower(pr.Stderr()), "not empty") {
		return typed(fsd.CodeNotEmpty, "directory not empty")
	}
	return e
}

func parseMode(s string) (fs.FileMode, error) {
	if len(s) < 3 || len(s) > 4 {
		return 0, errors.New("mode must be 3 or 4 octal digits")
	}
	var v uint32
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '7' {
			return 0, errors.New("mode must be octal")
		}
		v = v<<3 | uint32(s[i]-'0')
	}
	if v > 0o777 {
		return 0, errors.New("setuid, setgid and sticky bits are not allowed")
	}
	return fs.FileMode(v), nil
}
