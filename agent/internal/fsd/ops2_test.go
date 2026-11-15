package fsd

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

func shaHex(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func put(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	var te *Error
	if !errors.As(err, &te) || te.Code != code {
		t.Fatalf("err = %v, want code %q", err, code)
	}
}

// noParts fails the test if any .tugra-part-* residue exists anywhere under root.
func noParts(t *testing.T, root string) {
	t.Helper()
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && strings.HasPrefix(info.Name(), partPrefix) {
			t.Errorf("temp residue left behind: %s", p)
		}
		return nil
	})
}

func doWrite(root, rel, body string, o WriteOpts) (WriteResult, error) {
	o.Path = rel
	o.Size = int64(len(body))
	if o.Sha256 == "" {
		o.Sha256 = shaHex([]byte(body))
	}
	return WriteFile(root, o, strings.NewReader(body))
}

func TestWriteFileHappyAndOverwrite(t *testing.T) {
	root := t.TempDir()
	res, err := doWrite(root, "a.txt", "hello", WriteOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created || res.Bytes != 5 || res.Sha256 != shaHex([]byte("hello")) {
		t.Fatalf("result %+v", res)
	}
	b, _ := os.ReadFile(filepath.Join(root, "a.txt"))
	if string(b) != "hello" {
		t.Fatalf("content %q", b)
	}
	fi, _ := os.Stat(filepath.Join(root, "a.txt"))
	if fi.Mode().Perm() != 0o644 {
		t.Fatalf("default mode %v", fi.Mode().Perm())
	}
	// existing + no overwrite -> exists, content untouched
	_, err = doWrite(root, "a.txt", "other", WriteOpts{})
	wantCode(t, err, CodeExists)
	// overwrite keeps the existing mode unless one is requested
	_ = os.Chmod(filepath.Join(root, "a.txt"), 0o600)
	res, err = doWrite(root, "a.txt", "second", WriteOpts{Overwrite: true})
	if err != nil || res.Created {
		t.Fatalf("overwrite: %v %+v", err, res)
	}
	fi, _ = os.Stat(filepath.Join(root, "a.txt"))
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("overwrite should keep 0600, got %v", fi.Mode().Perm())
	}
	if _, err = doWrite(root, "a.txt", "third", WriteOpts{Overwrite: true, Mode: 0o640, HasMode: true}); err != nil {
		t.Fatal(err)
	}
	fi, _ = os.Stat(filepath.Join(root, "a.txt"))
	if fi.Mode().Perm() != 0o640 {
		t.Fatalf("explicit mode ignored: %v", fi.Mode().Perm())
	}
	noParts(t, root)
}

func TestWriteFileExplicitModeIgnoresUmask(t *testing.T) {
	root := t.TempDir()
	old := syscall.Umask(0o077)
	defer syscall.Umask(old)
	if _, err := doWrite(root, "x", "d", WriteOpts{Mode: 0o664, HasMode: true}); err != nil {
		t.Fatal(err)
	}
	fi, _ := os.Stat(filepath.Join(root, "x"))
	if fi.Mode().Perm() != 0o664 {
		t.Fatalf("umask leaked into the mode: %v", fi.Mode().Perm())
	}
}

func TestWriteFileIntegrityLeavesNothing(t *testing.T) {
	root := t.TempDir()
	_, err := WriteFile(root, WriteOpts{Path: "a", Size: 5, Sha256: strings.Repeat("0", 64)}, strings.NewReader("hello"))
	wantCode(t, err, CodeIntegrity)
	if _, serr := os.Lstat(filepath.Join(root, "a")); serr == nil {
		t.Fatal("destination created despite a hash mismatch")
	}
	noParts(t, root)
}

func TestWriteFileSizeMismatch(t *testing.T) {
	root := t.TempDir()
	// short source
	_, err := WriteFile(root, WriteOpts{Path: "s", Size: 10}, strings.NewReader("abc"))
	wantCode(t, err, CodeBadRequest)
	// long source
	_, err = WriteFile(root, WriteOpts{Path: "l", Size: 3}, strings.NewReader("abcdef"))
	wantCode(t, err, CodeBadRequest)
	for _, n := range []string{"s", "l"} {
		if _, serr := os.Lstat(filepath.Join(root, n)); serr == nil {
			t.Errorf("%s created", n)
		}
	}
	noParts(t, root)
}

func TestWriteFileIfMatch(t *testing.T) {
	root := t.TempDir()
	put(t, root, "f", "v1")
	st, err := Stat(root, "f")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = doWrite(root, "f", "v2", WriteOpts{Overwrite: true, IfMatch: st.Etag}); err != nil {
		t.Fatalf("matching etag refused: %v", err)
	}
	_, err = doWrite(root, "f", "v3", WriteOpts{Overwrite: true, IfMatch: st.Etag}) // stale now (size differs? same size but new mtime)
	if err == nil {
		// same size+same mtime ns would match; force a different etag deterministically
		put(t, root, "f", "longer content")
		_, err = doWrite(root, "f", "v4", WriteOpts{Overwrite: true, IfMatch: st.Etag})
	}
	wantCode(t, err, CodeChanged)
	// a deleted file with ifMatch set is also "changed"
	_, err = doWrite(root, "gone", "x", WriteOpts{Overwrite: true, IfMatch: "1-1"})
	wantCode(t, err, CodeChanged)
	noParts(t, root)
}

func TestWriteFileDestinationKinds(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := doWrite(root, "dir", "x", WriteOpts{Overwrite: true})
	wantCode(t, err, CodeIsDir)

	if err := syscall.Mkfifo(filepath.Join(root, "fifo"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err = doWrite(root, "fifo", "x", WriteOpts{Overwrite: true})
	wantCode(t, err, CodeNotRegular)

	put(t, root, "real", "r")
	if err := os.Symlink("real", filepath.Join(root, "lnk")); err != nil {
		t.Fatal(err)
	}
	_, err = doWrite(root, "lnk", "x", WriteOpts{Overwrite: true})
	wantCode(t, err, CodeNotRegular)
	if b, _ := os.ReadFile(filepath.Join(root, "real")); string(b) != "r" {
		t.Fatal("write through a final symlink modified its target")
	}

	// parent missing / parent a file
	_, err = doWrite(root, "nodir/x", "x", WriteOpts{})
	wantCode(t, err, CodeNotFound)
	_, err = doWrite(root, "real/x", "x", WriteOpts{})
	wantCode(t, err, CodeNotDir)
	noParts(t, root)
}

func TestSymlinkComponentsRefused(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	put(t, outside, "secret", "TOP")
	if err := os.Symlink(outside, filepath.Join(root, "esc")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "real"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real", filepath.Join(root, "inner")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(root, "pw")); err != nil {
		t.Fatal(err)
	}
	// symlink in an intermediate component (outside the root and inside it) is `denied` for every op
	for _, d := range []string{"esc", "inner"} {
		_, err := doWrite(root, d+"/new", "x", WriteOpts{})
		wantCode(t, err, CodeDenied)
		_, err = Stat(root, d+"/secret")
		wantCode(t, err, CodeDenied)
		wantCode(t, ReadFile(root, d+"/secret", 3, io.Discard), CodeDenied)
		_, err = Mkdir(root, d+"/m", 0o755, false)
		wantCode(t, err, CodeDenied)
		wantCode(t, Chmod(root, d+"/secret", 0o777), CodeDenied)
		wantCode(t, Remove(root, d+"/secret", false), CodeDenied)
		wantCode(t, Rename(root, d+"/secret", "moved"), CodeDenied)
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "secret")); string(b) != "TOP" {
		t.Fatal("outside file was modified")
	}
	// final-component symlink: stat reports it, read refuses, chmod refuses, remove unlinks only the link
	st, err := Stat(root, "pw")
	if err != nil || st.Type != "symlink" || st.LinkTarget != "/etc/passwd" {
		t.Fatalf("stat of link: %+v %v", st, err)
	}
	wantCode(t, ReadFile(root, "pw", 10, io.Discard), CodeNotRegular)
	wantCode(t, Chmod(root, "pw", 0o777), CodeDenied)
	if err := Remove(root, "esc", true); err != nil {
		t.Fatal(err)
	}
	if _, serr := os.Lstat(filepath.Join(root, "esc")); serr == nil {
		t.Fatal("link not removed")
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "secret")); string(b) != "TOP" {
		t.Fatal("recursive remove of a link followed it")
	}
	noParts(t, root)
}

func TestWriteFileStaleSweep(t *testing.T) {
	root := t.TempDir()
	old := time.Now().Add(-2 * time.Hour)
	mk := func(name string, age time.Time, dir bool) {
		p := filepath.Join(root, name)
		if dir {
			_ = os.Mkdir(p, 0o755)
		} else {
			_ = os.WriteFile(p, []byte("x"), 0o600)
		}
		_ = os.Chtimes(p, age, age)
	}
	mk(".tugra-part-0123456789abcdef", old, false)        // stale, exact pattern -> swept
	mk(".tugra-part-fedcba9876543210", time.Now(), false) // fresh -> kept
	mk(".tugra-part-0123456789abcde", old, false)         // wrong length -> kept
	mk(".tugra-part-ABCDEF0123456789", old, false)        // upper hex -> kept
	mk(".tugra-part-aaaaaaaaaaaaaaaa", old, true)         // a directory -> kept
	mk("user-file", old, false)                           // not a temp
	if _, err := doWrite(root, "new", "x", WriteOpts{}); err != nil {
		t.Fatal(err)
	}
	exists := func(n string) bool { _, err := os.Lstat(filepath.Join(root, n)); return err == nil }
	if exists(".tugra-part-0123456789abcdef") {
		t.Error("stale exact-pattern temp not swept")
	}
	for _, n := range []string{".tugra-part-fedcba9876543210", ".tugra-part-0123456789abcde", ".tugra-part-ABCDEF0123456789", ".tugra-part-aaaaaaaaaaaaaaaa", "user-file"} {
		if !exists(n) {
			t.Errorf("%s must NOT be swept", n)
		}
	}
}

type failingReader struct {
	data []byte
	err  error
}

func (f *failingReader) Read(p []byte) (int, error) {
	if len(f.data) == 0 {
		return 0, f.err
	}
	n := copy(p, f.data)
	f.data = f.data[n:]
	return n, nil
}

func TestWriteFileCleansTempOnReadError(t *testing.T) {
	root := t.TempDir()
	_, err := WriteFile(root, WriteOpts{Path: "a", Size: 100}, &failingReader{data: []byte("abc"), err: errors.New("boom")})
	if err == nil {
		t.Fatal("expected failure")
	}
	noParts(t, root)
	if _, serr := os.Lstat(filepath.Join(root, "a")); serr == nil {
		t.Fatal("partial destination")
	}
}

func TestWriteFileOwnershipInheritance(t *testing.T) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Skip("needs root on linux (covered by the dockerit suite)")
	}
	root := t.TempDir()
	if err := os.Chown(root, 999, 999); err != nil {
		t.Fatal(err)
	}
	if _, err := doWrite(root, "f", "x", WriteOpts{}); err != nil {
		t.Fatal(err)
	}
	st, _ := Stat(root, "f")
	if st.UID != 999 || st.GID != 999 {
		t.Fatalf("new file owner = %d:%d", st.UID, st.GID)
	}
}

func TestMkdir(t *testing.T) {
	root := t.TempDir()
	st, err := Mkdir(root, "a", 0o750, false)
	if err != nil || st.Type != "dir" || st.Mode != "0750" {
		t.Fatalf("mkdir: %+v %v", st, err)
	}
	_, err = Mkdir(root, "a", 0o750, false)
	wantCode(t, err, CodeExists)
	_, err = Mkdir(root, "x/y", 0o755, false)
	wantCode(t, err, CodeNotFound)
	// parents creates every level with the mode, and is a no-op on an existing dir
	st, err = Mkdir(root, "p/q/r", 0o755, true)
	if err != nil || st.Name != "r" {
		t.Fatalf("mkdir -p: %+v %v", st, err)
	}
	for _, d := range []string{"p", "p/q", "p/q/r"} {
		fi, serr := os.Stat(filepath.Join(root, d))
		if serr != nil || !fi.IsDir() || fi.Mode().Perm() != 0o755 {
			t.Fatalf("%s: %v %v", d, fi, serr)
		}
	}
	if _, err = Mkdir(root, "p/q/r", 0o755, true); err != nil {
		t.Fatalf("mkdir -p on an existing dir: %v", err)
	}
	put(t, root, "file", "x")
	_, err = Mkdir(root, "file", 0o755, true)
	wantCode(t, err, CodeExists)
	_, err = Mkdir(root, "file/sub", 0o755, true)
	wantCode(t, err, CodeNotDir)
	_, err = Mkdir(root, ".tugra-part-x", 0o755, false)
	wantCode(t, err, CodeBadRequest)
}

func TestMkdirParentsOwnershipPerLevel(t *testing.T) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Skip("needs root on linux (covered by the dockerit suite)")
	}
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Chown(filepath.Join(root, "app"), 1234, 4321)
	if _, err := Mkdir(root, "app/a/b", 0o755, true); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"app/a", "app/a/b"} {
		st, _ := Stat(root, d)
		if st.UID != 1234 || st.GID != 4321 {
			t.Fatalf("%s owner = %d:%d", d, st.UID, st.GID)
		}
	}
}

func TestRename(t *testing.T) {
	root := t.TempDir()
	put(t, root, "a/f", "1")
	put(t, root, "b", "2")
	if err := os.Mkdir(filepath.Join(root, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	wantCode(t, Rename(root, "a", "a/inside"), CodeBadRequest)
	wantCode(t, Rename(root, "a", "a"), CodeBadRequest)
	wantCode(t, Rename(root, "a/f", "b"), CodeExists)
	wantCode(t, Rename(root, "a/f", "d"), CodeExists) // never move INTO an existing dir
	wantCode(t, Rename(root, "missing", "z"), CodeNotFound)
	wantCode(t, Rename(root, "a/f", "nodir/z"), CodeNotFound)
	wantCode(t, Rename(root, "b", "a/f/x"), CodeNotDir)
	wantCode(t, Rename(root, "", "z"), CodeBadRequest)
	wantCode(t, Rename(root, "a", ""), CodeBadRequest)
	wantCode(t, Rename(root, "a", ".tugra-part-0123456789abcdef"), CodeBadRequest)
	wantCode(t, Rename(root, ".tugra-part-0123456789abcdef", "a2"), CodeBadRequest)
	if err := Rename(root, "a/f", "d/moved"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "d/moved")); string(b) != "1" {
		t.Fatal("moved content wrong")
	}
	// a directory rename keeps its subtree
	if err := Rename(root, "a", "a2"); err != nil {
		t.Fatal(err)
	}
}

func TestChmod(t *testing.T) {
	root := t.TempDir()
	put(t, root, "f", "x")
	if err := os.Mkdir(filepath.Join(root, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("f", filepath.Join(root, "l")); err != nil {
		t.Fatal(err)
	}
	if err := Chmod(root, "f", 0o600); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(filepath.Join(root, "f")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	if err := Chmod(root, "d", 0o700); err != nil {
		t.Fatal(err)
	}
	wantCode(t, Chmod(root, "l", 0o777), CodeDenied)
	wantCode(t, Chmod(root, "f", 0o4755), CodeBadRequest)
	wantCode(t, Chmod(root, "nope", 0o644), CodeNotFound)
	wantCode(t, Chmod(root, "", 0o644), CodeBadRequest)
	if fi, _ := os.Stat(filepath.Join(root, "f")); fi.Mode().Perm() != 0o600 {
		t.Fatal("refused chmod still changed the mode")
	}
	// never recursive: a child keeps its mode
	put(t, root, "d/c", "x")
	_ = os.Chmod(filepath.Join(root, "d/c"), 0o644)
	_ = Chmod(root, "d", 0o755)
	if fi, _ := os.Stat(filepath.Join(root, "d/c")); fi.Mode().Perm() != 0o644 {
		t.Fatal("chmod recursed")
	}
}

func TestRemove(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	put(t, outside, "keep", "K")
	put(t, root, "d/a", "1")
	put(t, root, "d/sub/b", "2")
	if err := os.Symlink(outside, filepath.Join(root, "d/sub/link")); err != nil {
		t.Fatal(err)
	}
	put(t, root, "f", "x")
	wantCode(t, Remove(root, "", true), CodeBadRequest)
	wantCode(t, Remove(root, "missing", false), CodeNotFound)
	wantCode(t, Remove(root, "d", false), CodeNotEmpty)
	if err := Remove(root, "f", false); err != nil {
		t.Fatal(err)
	}
	if err := Remove(root, "d", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, "d")); err == nil {
		t.Fatal("d survived")
	}
	if b, _ := os.ReadFile(filepath.Join(outside, "keep")); string(b) != "K" {
		t.Fatal("recursive remove followed an internal symlink out of the volume")
	}
}

func TestReadFile(t *testing.T) {
	root := t.TempDir()
	put(t, root, "f", "hello world")
	var buf bytes.Buffer
	if err := ReadFile(root, "f", 11, &buf); err != nil || buf.String() != "hello world" {
		t.Fatalf("read: %v %q", err, buf.String())
	}
	wantCode(t, ReadFile(root, "f", 10, io.Discard), CodeChanged)
	wantCode(t, ReadFile(root, "f", 12, io.Discard), CodeChanged)
	wantCode(t, ReadFile(root, "missing", 1, io.Discard), CodeNotFound)
	if err := os.Mkdir(filepath.Join(root, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	wantCode(t, ReadFile(root, "d", 0, io.Discard), CodeIsDir)
	wantCode(t, ReadFile(root, "f", -1, io.Discard), CodeBadRequest)
	// zero-byte file
	put(t, root, "empty", "")
	if err := ReadFile(root, "empty", 0, io.Discard); err != nil {
		t.Fatal(err)
	}
	// a FIFO is refused without ever blocking
	if err := syscall.Mkfifo(filepath.Join(root, "fifo"), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- ReadFile(root, "fifo", 0, io.Discard) }()
	select {
	case err := <-done:
		wantCode(t, err, CodeNotRegular)
	case <-time.After(5 * time.Second):
		t.Fatal("ReadFile blocked on a FIFO")
	}
	// a big file streams in full across several buffers
	big := strings.Repeat("0123456789", 30000) // 300 KB
	put(t, root, "big", big)
	buf.Reset()
	if err := ReadFile(root, "big", int64(len(big)), &buf); err != nil || buf.String() != big {
		t.Fatalf("big read: %v len=%d", err, buf.Len())
	}
}

func TestStat(t *testing.T) {
	root := t.TempDir()
	put(t, root, "f", "abc")
	st, err := Stat(root, "f")
	if err != nil || st.Name != "f" || st.Type != "file" || st.Size != 3 || st.Mode != "0644" {
		t.Fatalf("%+v %v", st, err)
	}
	if st.Etag != etagOf(3, st.MtimeNs) || st.MtimeNs/1e9 != st.Mtime {
		t.Fatalf("etag/mtime: %+v", st)
	}
	rs, err := Stat(root, "")
	if err != nil || rs.Type != "dir" || rs.Name != "" {
		t.Fatalf("root: %+v %v", rs, err)
	}
	_, err = Stat(root, "nope")
	wantCode(t, err, CodeNotFound)
	_, err = Stat(root, "../x")
	wantCode(t, err, CodeBadRequest)
}

func TestClassify(t *testing.T) {
	cases := map[error]string{
		os.ErrNotExist:                         CodeNotFound,
		os.ErrExist:                            CodeExists,
		syscall.ENOTDIR:                        CodeNotDir,
		syscall.EISDIR:                         CodeIsDir,
		syscall.ENOTEMPTY:                      CodeNotEmpty,
		syscall.EACCES:                         CodeDenied,
		syscall.EPERM:                          CodeDenied,
		syscall.ENOSPC:                         CodeNoSpace,
		syscall.EDQUOT:                         CodeNoSpace,
		syscall.EROFS:                          CodeReadOnly,
		syscall.EINVAL:                         CodeBadRequest,
		errors.New("path escapes from parent"): CodeDenied,
		errors.New("weird"):                    CodeFailed,
	}
	for in, want := range cases {
		if got := classify(in); got.Code != want {
			t.Errorf("classify(%v) = %s want %s", in, got.Code, want)
		}
	}
	te := errf(CodeBusy, "x")
	if classify(te) != te {
		t.Error("typed error must pass through")
	}
	if classify(nil) != nil {
		t.Error("nil must stay nil")
	}
}
