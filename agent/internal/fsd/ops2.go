package fsd

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// Closed set of failure codes (mirrors FS_ERROR_CODES in packages/shared). They travel agent -> hub -> HTTP -> UI.
const (
	CodeNotFound   = "not_found"
	CodeExists     = "exists"
	CodeNotDir     = "not_dir"
	CodeIsDir      = "is_dir"
	CodeNotRegular = "not_regular"
	CodeNotEmpty   = "not_empty"
	CodeDenied     = "denied"
	CodeReadOnly   = "read_only"
	CodeNoSpace    = "no_space"
	CodeTooLarge   = "too_large"
	CodeChanged    = "changed"
	CodeIntegrity  = "integrity"
	CodeBadRequest = "bad_request"
	CodeUnsupp     = "unsupported"
	CodeNotConf    = "not_configured"
	CodeBusy       = "busy"
	CodeExpired    = "expired"
	CodeNotRunning = "not_running"
	CodeNoBinary   = "no_binary"
	CodeFailed     = "failed"
)

// Error is a typed fs2 failure. Its stderr rendering is "fsd: [code] msg", which Launch2 parses back.
type Error struct{ Code, Msg string }

func (e *Error) Error() string { return "[" + e.Code + "] " + e.Msg }

func errf(code, format string, a ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

// classify maps an OS error to a typed Error. Already-typed errors pass through.
func classify(err error) *Error {
	if err == nil {
		return nil
	}
	var te *Error
	if errors.As(err, &te) {
		return te
	}
	// Errno first: syscall.ENOTEMPTY also satisfies errors.Is(err, fs.ErrExist), so the specific codes must win.
	var en syscall.Errno
	if errors.As(err, &en) {
		switch en {
		case syscall.ENOTDIR:
			return errf(CodeNotDir, "not a directory")
		case syscall.EISDIR:
			return errf(CodeIsDir, "is a directory")
		case syscall.ENOTEMPTY:
			return errf(CodeNotEmpty, "directory not empty")
		case syscall.EACCES, syscall.EPERM:
			return errf(CodeDenied, "permission denied")
		case syscall.ENOSPC, syscall.EDQUOT:
			return errf(CodeNoSpace, "no space left on volume")
		case syscall.EROFS:
			return errf(CodeReadOnly, "read-only file system")
		case syscall.EINVAL:
			return errf(CodeBadRequest, "invalid argument")
		case syscall.EXDEV, syscall.ELOOP:
			return errf(CodeDenied, "path escapes the volume")
		}
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return errf(CodeNotFound, "no such file or directory")
	case errors.Is(err, fs.ErrExist):
		return errf(CodeExists, "already exists")
	}
	// os.Root reports an escape attempt as a plain error ("path escapes from parent").
	if strings.Contains(err.Error(), "path escapes") {
		return errf(CodeDenied, "path escapes the volume")
	}
	return errf(CodeFailed, "%s", err.Error())
}

// WriteOpts configures WriteFile. Mode is applied only when HasMode.
type WriteOpts struct {
	Path      string
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

func etagOf(size, mtimeNs int64) string { return fmt.Sprintf("%d-%d", size, mtimeNs) }

func statOf(name string, fi fs.FileInfo) protocol.FsStat {
	st := protocol.FsStat{
		Name:    name,
		Type:    kind(fi.Mode()),
		Size:    fi.Size(),
		Mode:    fmt.Sprintf("%04o", uint32(fi.Mode().Perm())),
		Mtime:   fi.ModTime().Unix(),
		MtimeNs: fi.ModTime().UnixNano(),
	}
	st.Etag = etagOf(st.Size, st.MtimeNs)
	if uid, gid, ok := ownerOf(fi); ok {
		st.UID, st.GID = uid, gid
	}
	return st
}

// walkNoSymlink Lstat's every PARENT component of rel inside root; a symlink in the chain is `denied`. os.Root
// already confines resolution to the volume; this is the policy layer that refuses to traverse links at all, so
// a link the app planted (even one pointing inside the volume) can never redirect a privileged mutation.
// A missing component is not an error here (the operation itself reports not_found).
func walkNoSymlink(root *os.Root, rel string) error {
	if rel == "" {
		return nil
	}
	segs := strings.Split(rel, "/")
	cur := ""
	for _, seg := range segs[:len(segs)-1] {
		if cur == "" {
			cur = seg
		} else {
			cur = cur + "/" + seg
		}
		fi, err := root.Lstat(cur)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return classify(err)
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return errf(CodeDenied, "symlink in path")
		}
		if !fi.IsDir() {
			return errf(CodeNotDir, "a path component is not a directory")
		}
	}
	return nil
}

func parentOf(rel string) string {
	if i := strings.LastIndexByte(rel, '/'); i >= 0 {
		return rel[:i]
	}
	return ""
}

func nameOrDot(rel string) string {
	if rel == "" {
		return "."
	}
	return rel
}

// Stat reports one object without dereferencing it. The volume root ("") is allowed.
func Stat(rootPath, rel string) (protocol.FsStat, error) {
	if err := validatePath2(rel, true); err != nil {
		return protocol.FsStat{}, errf(CodeBadRequest, "%s", err.Error())
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return protocol.FsStat{}, classify(err)
	}
	defer root.Close()
	if err := walkNoSymlink(root, rel); err != nil {
		return protocol.FsStat{}, err
	}
	return statIn(root, rel)
}

func statIn(root *os.Root, rel string) (protocol.FsStat, error) {
	fi, err := root.Lstat(nameOrDot(rel))
	if err != nil {
		return protocol.FsStat{}, classify(err)
	}
	st := statOf(path.Base(rel), fi)
	if rel == "" {
		st.Name = ""
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		if t, rerr := root.Readlink(rel); rerr == nil {
			st.LinkTarget = t
		}
	}
	return st, nil
}

const readBufSize = 64 << 10

// ReadFile streams exactly size bytes of a regular file to dst. The expected size comes from a prior Stat; a
// file that changed in between is `changed`. Only regular files are ever opened (a FIFO/device would block or
// leak), and the open itself is non-blocking as a second guard.
func ReadFile(rootPath, rel string, size int64, dst io.Writer) error {
	if err := validatePath2(rel, false); err != nil {
		return errf(CodeBadRequest, "%s", err.Error())
	}
	if size < 0 {
		return errf(CodeBadRequest, "size is required")
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return classify(err)
	}
	defer root.Close()
	if err := walkNoSymlink(root, rel); err != nil {
		return err
	}
	li, err := root.Lstat(rel)
	if err != nil {
		return classify(err)
	}
	if li.IsDir() {
		return errf(CodeIsDir, "is a directory")
	}
	if !li.Mode().IsRegular() {
		return errf(CodeNotRegular, "not a regular file")
	}
	f, err := root.OpenFile(rel, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return classify(err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return classify(err)
	}
	if !fi.Mode().IsRegular() {
		return errf(CodeNotRegular, "not a regular file")
	}
	if fi.Size() != size {
		return errf(CodeChanged, "file size changed")
	}
	buf := make([]byte, readBufSize)
	var done int64
	for done < size {
		want := int64(len(buf))
		if size-done < want {
			want = size - done
		}
		n, rerr := f.Read(buf[:want])
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return errf(CodeFailed, "write failed: %v", werr)
			}
			done += int64(n)
		}
		if rerr != nil {
			if rerr == io.EOF && done < size {
				return errf(CodeChanged, "file shrank while reading")
			}
			if rerr != io.EOF {
				return classify(rerr)
			}
			break
		}
	}
	if done != size {
		return errf(CodeChanged, "file shrank while reading")
	}
	return nil
}

var staleSweepRe = regexp.MustCompile(`^\.tugra-part-[0-9a-f]{16}$`)

// sweepStaleParts removes this dir's own abandoned temp files (exact name pattern, regular, older than 1h),
// best effort over the first 512 entries. A crash between create and rename is the only way one survives.
func sweepStaleParts(root *os.Root, dir string) {
	d, err := root.Open(nameOrDot(dir))
	if err != nil {
		return
	}
	defer d.Close()
	des, _ := d.ReadDir(512)
	for _, de := range des {
		if !staleSweepRe.MatchString(de.Name()) || !de.Type().IsRegular() {
			continue
		}
		info, ierr := de.Info()
		if ierr != nil || time.Since(info.ModTime()) < time.Hour {
			continue
		}
		p := de.Name()
		if dir != "" {
			p = dir + "/" + de.Name()
		}
		_ = root.Remove(p)
	}
}

// linkUnsupported reports a link(2) failure caused by the filesystem rather than by a name clash.
func linkUnsupported(err error) bool {
	var en syscall.Errno
	if !errors.As(err, &en) {
		return false
	}
	switch en {
	case syscall.EPERM, syscall.ENOTSUP, syscall.EOPNOTSUPP, syscall.ENOSYS, syscall.EMLINK, syscall.EXDEV:
		return true
	}
	return false
}

func randHex16() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// WriteFile stores exactly o.Size bytes from src at o.Path atomically: a temp file in the SAME directory is
// filled, hashed, fsynced, given its final mode and ownership, then renamed (overwrite) or hard-linked
// (no-replace) into place. The temp is removed on every error path.
func WriteFile(rootPath string, o WriteOpts, src io.Reader) (WriteResult, error) {
	var zero WriteResult
	if err := validatePath2(o.Path, false); err != nil {
		return zero, errf(CodeBadRequest, "%s", err.Error())
	}
	if o.Size < 0 {
		return zero, errf(CodeBadRequest, "size is required")
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return zero, classify(err)
	}
	defer root.Close()
	if err := walkNoSymlink(root, o.Path); err != nil {
		return zero, err
	}
	parent := parentOf(o.Path)
	pi, err := root.Lstat(nameOrDot(parent))
	if err != nil {
		return zero, classify(err)
	}
	if !pi.IsDir() {
		return zero, errf(CodeNotDir, "parent is not a directory")
	}
	var destInfo fs.FileInfo
	if di, derr := root.Lstat(o.Path); derr == nil {
		destInfo = di
		switch {
		case !o.Overwrite:
			return zero, errf(CodeExists, "already exists")
		case di.IsDir():
			return zero, errf(CodeIsDir, "is a directory")
		case !di.Mode().IsRegular():
			return zero, errf(CodeNotRegular, "not a regular file")
		}
		if o.IfMatch != "" && etagOf(di.Size(), di.ModTime().UnixNano()) != o.IfMatch {
			return zero, errf(CodeChanged, "file changed since it was read")
		}
	} else if !errors.Is(derr, fs.ErrNotExist) {
		return zero, classify(derr)
	} else if o.IfMatch != "" {
		return zero, errf(CodeChanged, "file no longer exists")
	}

	sweepStaleParts(root, parent)

	tmpName := partPrefix + randHex16()
	tmp := tmpName
	if parent != "" {
		tmp = parent + "/" + tmpName
	}
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return zero, classify(err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = f.Close()
			_ = root.Remove(tmp)
		}
	}()

	h := sha256.New()
	n, cerr := io.CopyN(io.MultiWriter(f, h), src, o.Size)
	if cerr != nil {
		if errors.Is(cerr, io.EOF) {
			return zero, errf(CodeBadRequest, "body shorter than declared size (%d of %d)", n, o.Size)
		}
		return zero, classify(cerr)
	}
	var extra [1]byte
	if m, _ := src.Read(extra[:]); m > 0 {
		return zero, errf(CodeBadRequest, "body longer than declared size")
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if o.Sha256 != "" && !strings.EqualFold(o.Sha256, sum) {
		return zero, errf(CodeIntegrity, "content hash mismatch")
	}
	if err := f.Sync(); err != nil {
		return zero, classify(err)
	}

	mode := fs.FileMode(0o644)
	switch {
	case o.HasMode:
		mode = o.Mode
	case destInfo != nil:
		mode = destInfo.Mode().Perm()
	}
	if err := f.Chmod(mode); err != nil { // explicit, so the umask never applies
		return zero, classify(err)
	}
	// Ownership: an existing file keeps its owner; a new one inherits the parent dir's. Fail closed — never
	// silently leave root-owned files in an app's volume (userns-remapped Docker lands here).
	ownerSrc := pi
	if destInfo != nil {
		ownerSrc = destInfo
	}
	if uid, gid, ok := ownerOf(ownerSrc); ok {
		if err := root.Chown(tmp, uid, gid); err != nil {
			return zero, errf(CodeDenied, "cannot set ownership")
		}
	}
	if err := f.Close(); err != nil {
		return zero, classify(err)
	}

	created := destInfo == nil
	if o.Overwrite {
		if err := root.Rename(tmp, o.Path); err != nil {
			return zero, classify(err)
		}
		committed = true
	} else {
		if err := root.Link(tmp, o.Path); err != nil {
			if !linkUnsupported(err) {
				return zero, classify(err)
			}
			// The volume's filesystem (NFS/CIFS/FUSE drivers, ...) has no hard links. Fall back to a checked rename: the
			// stdlib has no RENAME_NOREPLACE, so a race against the app itself inside the volume is accepted (documented).
			if _, lerr := root.Lstat(o.Path); lerr == nil {
				return zero, errf(CodeExists, "already exists")
			}
			if rerr := root.Rename(tmp, o.Path); rerr != nil {
				return zero, classify(rerr)
			}
			committed = true
		} else {
			committed = true // the final name exists now; only the temp name is left to drop
			_ = root.Remove(tmp)
		}
	}
	res := WriteResult{Bytes: n, Sha256: sum, Created: created}
	if fi, ferr := root.Lstat(o.Path); ferr == nil {
		res.Etag = etagOf(fi.Size(), fi.ModTime().UnixNano())
	} else {
		res.Etag = etagOf(n, time.Now().UnixNano())
	}
	return res, nil
}

// Mkdir creates a directory. With parents every missing level is created individually (root.Mkdir + Chown to
// the nearest existing ancestor's owner + explicit Chmod), so ownership is right at every level. Intermediate
// levels are 0755; only the final directory takes the requested mode.
func Mkdir(rootPath, rel string, mode fs.FileMode, parents bool) (protocol.FsStat, error) {
	if err := validatePath2(rel, false); err != nil {
		return protocol.FsStat{}, errf(CodeBadRequest, "%s", err.Error())
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return protocol.FsStat{}, classify(err)
	}
	defer root.Close()
	if err := walkNoSymlink(root, rel); err != nil {
		return protocol.FsStat{}, err
	}
	if fi, derr := root.Lstat(rel); derr == nil {
		if parents && fi.IsDir() {
			return statIn(root, rel) // mkdir -p on an existing directory is a no-op
		}
		return protocol.FsStat{}, errf(CodeExists, "already exists")
	} else if !errors.Is(derr, fs.ErrNotExist) {
		return protocol.FsStat{}, classify(derr)
	}

	makeOne := func(p string, ownerFrom fs.FileInfo, mode fs.FileMode) error {
		if err := root.Mkdir(p, 0o700); err != nil {
			return classify(err)
		}
		if uid, gid, ok := ownerOf(ownerFrom); ok {
			if err := root.Chown(p, uid, gid); err != nil {
				_ = root.Remove(p)
				return errf(CodeDenied, "cannot set ownership")
			}
		}
		if err := root.Chmod(p, mode); err != nil {
			return classify(err)
		}
		return nil
	}

	parent := parentOf(rel)
	if !parents {
		pi, perr := root.Lstat(nameOrDot(parent))
		if perr != nil {
			return protocol.FsStat{}, classify(perr)
		}
		if !pi.IsDir() {
			return protocol.FsStat{}, errf(CodeNotDir, "parent is not a directory")
		}
		if err := makeOne(rel, pi, mode); err != nil {
			return protocol.FsStat{}, err
		}
		return statIn(root, rel)
	}

	cur := ""
	anc, err := root.Lstat(".")
	if err != nil {
		return protocol.FsStat{}, classify(err)
	}
	segsAll := strings.Split(rel, "/")
	for i, seg := range segsAll {
		if cur == "" {
			cur = seg
		} else {
			cur += "/" + seg
		}
		fi, lerr := root.Lstat(cur)
		switch {
		case lerr == nil:
			if fi.Mode()&fs.ModeSymlink != 0 {
				return protocol.FsStat{}, errf(CodeDenied, "symlink in path")
			}
			if !fi.IsDir() {
				return protocol.FsStat{}, errf(CodeNotDir, "a path component is not a directory")
			}
			anc = fi
		case errors.Is(lerr, fs.ErrNotExist):
			// Intermediate levels get a traversable 0755 (like `mkdir -p -m`): only the LEAF takes the requested mode,
			// so a restrictive mode can never leave the app uid unable to reach it.
			lvl := fs.FileMode(0o755)
			if i == len(segsAll)-1 {
				lvl = mode
			}
			if err := makeOne(cur, anc, lvl); err != nil {
				return protocol.FsStat{}, err
			}
			if ni, nerr := root.Lstat(cur); nerr == nil {
				anc = ni
			}
		default:
			return protocol.FsStat{}, classify(lerr)
		}
	}
	return statIn(root, rel)
}

// Rename moves from -> to inside the volume. The destination must not exist (stdlib has no RENAME_NOREPLACE, so a
// race against the app itself inside the volume is accepted and documented). Neither side may be the root.
func Rename(rootPath, from, to string) error {
	if err := validatePath2(from, false); err != nil {
		return errf(CodeBadRequest, "%s", err.Error())
	}
	if err := validatePath2(to, false); err != nil {
		return errf(CodeBadRequest, "%s", err.Error())
	}
	if from == to || strings.HasPrefix(to, from+"/") {
		return errf(CodeBadRequest, "cannot move an entry into itself")
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return classify(err)
	}
	defer root.Close()
	if err := walkNoSymlink(root, from); err != nil {
		return err
	}
	if err := walkNoSymlink(root, to); err != nil {
		return err
	}
	if _, err := root.Lstat(from); err != nil {
		return classify(err)
	}
	if _, err := root.Lstat(to); err == nil {
		return errf(CodeExists, "destination already exists")
	} else if !errors.Is(err, fs.ErrNotExist) {
		return classify(err)
	}
	pi, err := root.Lstat(nameOrDot(parentOf(to)))
	if err != nil {
		return classify(err)
	}
	if !pi.IsDir() {
		return errf(CodeNotDir, "destination parent is not a directory")
	}
	if err := root.Rename(from, to); err != nil {
		return classify(err)
	}
	return nil
}

// Chmod sets permission bits (<= 0777) on a regular file or directory; never recursive, never through a symlink.
func Chmod(rootPath, rel string, mode fs.FileMode) error {
	if err := validatePath2(rel, false); err != nil {
		return errf(CodeBadRequest, "%s", err.Error())
	}
	if mode > 0o777 {
		return errf(CodeBadRequest, "setuid, setgid and sticky bits are not allowed")
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return classify(err)
	}
	defer root.Close()
	if err := walkNoSymlink(root, rel); err != nil {
		return err
	}
	fi, err := root.Lstat(rel)
	if err != nil {
		return classify(err)
	}
	switch {
	case fi.Mode()&fs.ModeSymlink != 0:
		return errf(CodeDenied, "refusing to chmod a symlink")
	case !fi.Mode().IsRegular() && !fi.IsDir():
		return errf(CodeNotRegular, "not a regular file or directory")
	}
	if err := root.Chmod(rel, mode); err != nil {
		return classify(err)
	}
	return nil
}

// Remove deletes an entry. The root is refused. A symlink is unlinked itself, never followed. Recursive removal
// uses os.Root.RemoveAll (links removed, never traversed).
func Remove(rootPath, rel string, recursive bool) error {
	if err := validatePath2(rel, false); err != nil {
		return errf(CodeBadRequest, "%s", err.Error())
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return classify(err)
	}
	defer root.Close()
	if err := walkNoSymlink(root, rel); err != nil {
		return err
	}
	if _, err := root.Lstat(rel); err != nil {
		return classify(err)
	}
	if recursive {
		if err := root.RemoveAll(rel); err != nil {
			return classify(err)
		}
		return nil
	}
	if err := root.Remove(rel); err != nil {
		return classify(err)
	}
	return nil
}

// flagsRe is the whole flags vocabulary: o (overwrite), r (recursive), p (parents).
var flagsRe = regexp.MustCompile(`^[orp]*$`)

type cliArgs struct {
	path, path2, mode, flags, sha256, ifMatch string
	size                                      int64
	hasSize                                   bool
}

func parseCLIArgs(args []string) (cliArgs, error) {
	var a cliArgs
	for _, arg := range args {
		k, v, ok := strings.Cut(arg, "=")
		if !ok || !strings.HasPrefix(k, "--") {
			return a, fmt.Errorf("bad argument")
		}
		switch k {
		case "--path":
			a.path = v
		case "--path2":
			a.path2 = v
		case "--mode":
			a.mode = v
		case "--flags":
			if !flagsRe.MatchString(v) {
				return a, fmt.Errorf("bad flags")
			}
			a.flags = v
		case "--sha256":
			a.sha256 = v
		case "--if-match":
			a.ifMatch = v
		case "--size":
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 0 {
				return a, fmt.Errorf("bad size")
			}
			a.size, a.hasSize = n, true
		default:
			return a, fmt.Errorf("unknown option")
		}
	}
	return a, nil
}

// cli2Output is the JSON the non-read ops print on stdout (the launcher parses it into Result2).
type cli2Output struct {
	Stat    *protocol.FsStat `json:"stat,omitempty"`
	Bytes   int64            `json:"bytes,omitempty"`
	Sha256  string           `json:"sha256,omitempty"`
	Etag    string           `json:"etag,omitempty"`
	Created bool             `json:"created,omitempty"`
}

// RunCLI2 is the `tugra-agent fsd2 <op> --key=value...` entrypoint, run inside the sandboxed helper container.
// Exit 0 = ok (JSON on stdout, or raw file bytes for `read`); 1 = typed failure ("fsd: [code] msg" on stderr);
// 2 = usage.
func RunCLI2(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	return runCLI2(RootPath, args, stdin, stdout, stderr)
}

func runCLI2(root string, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) < 1 {
		fmt.Fprintln(stderr, "fsd: missing op")
		return 2
	}
	op := args[0]
	a, err := parseCLIArgs(args[1:])
	if err != nil {
		fmt.Fprintln(stderr, "fsd: [bad_request]", err.Error())
		return 2
	}
	fail := func(err error) int {
		te := classify(err)
		fmt.Fprintf(stderr, "fsd: [%s] %s\n", te.Code, te.Msg)
		return 1
	}
	emit := func(o cli2Output) int {
		if err := json.NewEncoder(stdout).Encode(o); err != nil {
			return fail(err)
		}
		return 0
	}
	var mode fs.FileMode
	hasMode := a.mode != ""
	if hasMode {
		m, err := validateMode(a.mode)
		if err != nil {
			return fail(errf(CodeBadRequest, "%s", err.Error()))
		}
		mode = m
	}
	switch op {
	case "stat":
		st, err := Stat(root, a.path)
		if err != nil {
			return fail(err)
		}
		return emit(cli2Output{Stat: &st})
	case "read":
		if !a.hasSize {
			return fail(errf(CodeBadRequest, "size is required"))
		}
		if err := ReadFile(root, a.path, a.size, stdout); err != nil {
			return fail(err)
		}
		return 0
	case "write":
		if !a.hasSize {
			return fail(errf(CodeBadRequest, "size is required"))
		}
		res, err := WriteFile(root, WriteOpts{
			Path: a.path, Mode: mode, HasMode: hasMode, Overwrite: strings.Contains(a.flags, "o"),
			Size: a.size, Sha256: a.sha256, IfMatch: a.ifMatch,
		}, stdin)
		if err != nil {
			return fail(err)
		}
		return emit(cli2Output{Bytes: res.Bytes, Sha256: res.Sha256, Etag: res.Etag, Created: res.Created})
	case "mkdir":
		if !hasMode {
			mode = 0o755
		}
		st, err := Mkdir(root, a.path, mode, strings.Contains(a.flags, "p"))
		if err != nil {
			return fail(err)
		}
		return emit(cli2Output{Stat: &st, Created: true})
	case "rename":
		if err := Rename(root, a.path, a.path2); err != nil {
			return fail(err)
		}
		st, err := Stat(root, a.path2)
		if err != nil {
			return fail(err)
		}
		return emit(cli2Output{Stat: &st})
	case "chmod":
		if !hasMode {
			return fail(errf(CodeBadRequest, "mode is required"))
		}
		if err := Chmod(root, a.path, mode); err != nil {
			return fail(err)
		}
		st, err := Stat(root, a.path)
		if err != nil {
			return fail(err)
		}
		return emit(cli2Output{Stat: &st})
	case "delete":
		if err := Remove(root, a.path, strings.Contains(a.flags, "r")); err != nil {
			return fail(err)
		}
		return emit(cli2Output{})
	default:
		fmt.Fprintln(stderr, "fsd: [bad_request] unsupported op")
		return 2
	}
}
