package ctrfs

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/fsd"
)

// ── fake docker ──────────────────────────────────────────────────────────────────────────────────────────────

type exitErr struct{ code int }

func (e exitErr) Error() string { return "exit status" }
func (e exitErr) ExitCode() int { return e.code }

type reply struct {
	stdout []byte
	stderr string
	err    error
}

type call struct {
	args  []string
	stdin []byte
}

type fakeDocker struct {
	mu      sync.Mutex
	calls   []call
	handler func(c call) reply
	killed  int
}

func (f *fakeDocker) install(t *testing.T) {
	t.Helper()
	orig := start
	start = func(ctx context.Context, stdin io.Reader, args ...string) (*proc, error) {
		var in []byte
		if stdin != nil {
			in, _ = io.ReadAll(stdin)
		}
		c := call{args: append([]string{}, args...), stdin: in}
		f.mu.Lock()
		f.calls = append(f.calls, c)
		f.mu.Unlock()
		r := f.handler(c)
		return &proc{
			Stdout: io.NopCloser(bytes.NewReader(r.stdout)),
			Wait:   func() error { return r.err },
			Stderr: func() string { return r.stderr },
			Kill:   func() { f.mu.Lock(); f.killed++; f.mu.Unlock() },
		}, nil
	}
	t.Cleanup(func() { start = orig })
}

func (f *fakeDocker) withArg(s string) []call {
	var out []call
	for _, c := range f.calls {
		for _, a := range c.args {
			if a == s {
				out = append(out, c)
				break
			}
		}
	}
	return out
}

type ent struct {
	name     string
	typ      byte
	size     int64
	mode     int64
	uid, gid int
	link     string
	body     string
	uname    string
}

func mkTar(t *testing.T, ents ...ent) []byte {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	for _, e := range ents {
		size := e.size
		if e.typ == tar.TypeReg && size == 0 {
			size = int64(len(e.body))
		}
		h := &tar.Header{Name: e.name, Typeflag: e.typ, Size: size, Mode: e.mode, Uid: e.uid, Gid: e.gid, Linkname: e.link, Uname: e.uname, ModTime: time.Unix(1700000000, 123)}
		if e.typ != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			_, _ = tw.Write([]byte(e.body))
		}
	}
	_ = tw.Close()
	return b.Bytes()
}

func code(err error) string {
	var te *fsd.Error
	if errors.As(err, &te) {
		return te.Code
	}
	if err == nil {
		return ""
	}
	return "untyped:" + err.Error()
}

var bg = context.Background()

// ── validation ───────────────────────────────────────────────────────────────────────────────────────────────

func TestValidateName(t *testing.T) {
	for _, ok := range []string{"tugra_abc123", "tugra_c1-web-1", "tugra_a.b_c-d", "tugra_x"} {
		if err := ValidateName(ok); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "tugra_", "nginx", "tugra", "tugra_-x", "tugra_a b", "tugra_a;rm", "tugra_a/../b", "tugra_x__rollout", "tugra_c1__prev", "-tugra_x", "tugra_" + strings.Repeat("a", 128), "TUGRA_x", "tugra_a\n"} {
		if err := ValidateName(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestValidatePath(t *testing.T) {
	for _, ok := range []string{"/", "/app", "/etc/nginx/nginx.conf", "/app/a b", "/procfs", "/system", "/devices", "/app/proc"} {
		if err := ValidatePath(ok, false); err != nil {
			t.Errorf("%q refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "app", "/a/../b", "/a/./b", "/a//b", "/a/", "/a\x00b", "/a\nb", "/a\\b", "/proc", "/proc/1/environ", "/sys", "/sys/x", "/dev", "/dev/null", "/" + strings.Repeat("a", 4096)} {
		if err := ValidatePath(bad, false); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if ValidatePath("/", true) == nil {
		t.Error("mutations must refuse /")
	}
	if ValidatePath("/app", true) != nil {
		t.Error("mutating a normal path must be allowed")
	}
}

// ── Stat ─────────────────────────────────────────────────────────────────────────────────────────────────────

func TestStatDecodesHeaders(t *testing.T) {
	cases := map[string]struct {
		tarball []byte
		want    string
		check   func(*testing.T, protoStat)
	}{
		"file": {mkTar(t, ent{name: "hosts", typ: tar.TypeReg, mode: 0o640, uid: 1, gid: 2, body: "12345", uname: "root"}), "/etc/hosts", func(t *testing.T, s protoStat) {
			if s.Type != "file" || s.Size != 5 || s.Mode != "0640" || s.UID != 1 || s.GID != 2 || s.Name != "hosts" || s.Uname != "root" {
				t.Errorf("%+v", s)
			}
			if s.Etag != "5-1700000000000000000" || s.Mtime != 1700000000 { // tar headers carry second precision
				t.Errorf("etag/mtime %+v", s)
			}
		}},
		"dir": {mkTar(t, ent{name: "etc/", typ: tar.TypeDir, mode: 0o755}), "/etc", func(t *testing.T, s protoStat) {
			if s.Type != "dir" || s.Size != 0 || s.Mode != "0755" || s.Name != "etc" {
				t.Errorf("%+v", s)
			}
		}},
		"symlink": {mkTar(t, ent{name: "localtime", typ: tar.TypeSymlink, mode: 0o777, link: "/usr/share/zoneinfo/UTC"}), "/etc/localtime", func(t *testing.T, s protoStat) {
			if s.Type != "symlink" || s.LinkTarget != "/usr/share/zoneinfo/UTC" {
				t.Errorf("%+v", s)
			}
		}},
		"fifo": {mkTar(t, ent{name: "p", typ: tar.TypeFifo, mode: 0o644}), "/tmp/p", func(t *testing.T, s protoStat) {
			if s.Type != "other" {
				t.Errorf("%+v", s)
			}
		}},
		"root": {mkTar(t, ent{name: "./", typ: tar.TypeDir, mode: 0o755}), "/", func(t *testing.T, s protoStat) {
			if s.Name != "" || s.Type != "dir" {
				t.Errorf("%+v", s)
			}
		}},
	}
	for n, c := range cases {
		f := &fakeDocker{handler: func(call) reply { return reply{stdout: c.tarball} }}
		f.install(t)
		st, err := Stat(bg, "tugra_a", c.want)
		if err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		c.check(t, st)
		if got := strings.Join(f.calls[0].args, " "); got != "cp tugra_a:"+c.want+" -" {
			t.Errorf("%s argv %q", n, got)
		}
		if f.killed == 0 {
			t.Errorf("%s: the CLI must be killed after the first header", n)
		}
	}
}

type protoStat = struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	Mode       string `json:"mode"`
	Mtime      int64  `json:"mtime"`
	MtimeNs    int64  `json:"mtimeNs"`
	UID        int    `json:"uid"`
	GID        int    `json:"gid"`
	Etag       string `json:"etag"`
	LinkTarget string `json:"linkTarget,omitempty"`
	Uname      string `json:"uname,omitempty"`
	Gname      string `json:"gname,omitempty"`
}

func TestStatErrors(t *testing.T) {
	cases := []struct {
		name   string
		r      reply
		want   string
		simple bool
	}{
		{"no container", reply{stderr: "Error response from daemon: No such container: tugra_a", err: exitErr{1}}, "not_running", false},
		{"missing file", reply{stderr: "Error response from daemon: Could not find the file /nope in container tugra_a", err: exitErr{1}}, "not_found", false},
		{"empty archive", reply{}, "not_found", false},
		{"other", reply{stderr: "boom\nwith\x1bcontrol", err: exitErr{1}}, "failed", false},
	}
	for _, c := range cases {
		f := &fakeDocker{handler: func(call) reply { return c.r }}
		f.install(t)
		_, err := Stat(bg, "tugra_a", "/nope")
		if code(err) != c.want {
			t.Errorf("%s: %v", c.name, err)
		}
		var te *fsd.Error
		if errors.As(err, &te) && strings.ContainsAny(te.Msg, "\x1b\n") {
			t.Errorf("%s: control characters leaked: %q", c.name, te.Msg)
		}
	}
}

func TestStatRejectsBadInputWithoutRunningDocker(t *testing.T) {
	f := &fakeDocker{handler: func(call) reply { t.Fatal("docker must not run"); return reply{} }}
	f.install(t)
	for _, c := range [][2]string{{"nginx", "/etc"}, {"tugra_a", "etc"}, {"tugra_a", "/proc/1"}, {"tugra_a", "/a/../b"}, {"-x", "/etc"}} {
		if _, err := Stat(bg, c[0], c[1]); code(err) != "bad_request" {
			t.Errorf("%v: %v", c, err)
		}
	}
}

// ── List ─────────────────────────────────────────────────────────────────────────────────────────────────────

func TestListKeepsOnlyDirectChildren(t *testing.T) {
	tarball := mkTar(t,
		ent{name: "app/", typ: tar.TypeDir, mode: 0o755},
		ent{name: "app/index.js", typ: tar.TypeReg, mode: 0o644, body: "abc"},
		ent{name: "app/node_modules/", typ: tar.TypeDir, mode: 0o755},
		ent{name: "app/node_modules/x/", typ: tar.TypeDir, mode: 0o755},
		ent{name: "app/node_modules/x/y.js", typ: tar.TypeReg, mode: 0o644, body: "zzzzzz"},
		ent{name: "app/link", typ: tar.TypeSymlink, mode: 0o777, link: "index.js"},
		ent{name: "app/index.js", typ: tar.TypeReg, mode: 0o644, body: "dup"}, // duplicate name: first wins
	)
	f := &fakeDocker{handler: func(call) reply { return reply{stdout: tarball} }}
	f.install(t)
	es, trunc, err := List(bg, "tugra_a", "/app")
	if err != nil || trunc {
		t.Fatalf("%v %v", err, trunc)
	}
	got := map[string]string{}
	for _, e := range es {
		got[e.Name] = e.Type
	}
	want := map[string]string{"index.js": "file", "node_modules": "dir", "link": "symlink"}
	if len(got) != len(want) {
		t.Fatalf("entries %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q", k, got[k])
		}
	}
	for _, e := range es {
		if e.Name == "index.js" && (e.Size != 3 || e.Mode != "-rw-r--r--") {
			t.Errorf("legacy FsEntry shape: %+v", e)
		}
	}
}

func TestListToleratesRootLayouts(t *testing.T) {
	// docker's naming for "/" differs from an ordinary directory; the parser must cope with each plausible layout.
	layouts := map[string][]ent{
		"dot-slash": {{name: "./", typ: tar.TypeDir}, {name: "./etc/", typ: tar.TypeDir}, {name: "./etc/hosts", typ: tar.TypeReg, body: "x"}, {name: "./bin", typ: tar.TypeSymlink, link: "usr/bin"}},
		"slash":     {{name: "/", typ: tar.TypeDir}, {name: "/etc/", typ: tar.TypeDir}, {name: "/bin", typ: tar.TypeSymlink, link: "usr/bin"}},
	}
	for n, ents := range layouts {
		f := &fakeDocker{handler: func(call) reply { return reply{stdout: mkTar(t, ents...)} }}
		f.install(t)
		es, _, err := List(bg, "tugra_a", "/")
		if err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		got := map[string]string{}
		for _, e := range es {
			got[e.Name] = e.Type
		}
		if got["etc"] != "dir" || got["bin"] != "symlink" || len(got) != 2 {
			t.Errorf("%s: %v", n, got)
		}
	}
}

func TestListResolvesASymlinkedDirectoryThroughTrailingDot(t *testing.T) {
	// /app -> /usr/src/app: docker cp answers a bare symlink header; the listing is retried through "/." which archives
	// the resolved directory's contents.
	contents := mkTar(t, ent{name: "./", typ: tar.TypeDir}, ent{name: "./index.js", typ: tar.TypeReg, body: "x"}, ent{name: "./lib/", typ: tar.TypeDir})
	f := &fakeDocker{handler: func(c call) reply {
		if strings.HasSuffix(c.args[1], "/.") {
			return reply{stdout: contents}
		}
		return reply{stdout: mkTar(t, ent{name: "app", typ: tar.TypeSymlink, link: "/usr/src/app"})}
	}}
	f.install(t)
	es, _, err := List(bg, "tugra_a", "/app")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, e := range es {
		got[e.Name] = e.Type
	}
	if got["index.js"] != "file" || got["lib"] != "dir" || len(got) != 2 {
		t.Fatalf("%v", got)
	}
	if len(f.calls) != 2 || strings.Join(f.calls[1].args, " ") != "cp tugra_a:/app/. -" {
		t.Fatalf("calls %v", f.calls)
	}
	// a symlink that STILL does not resolve to a directory is not_dir (no loop)
	g := &fakeDocker{handler: func(c call) reply {
		return reply{stdout: mkTar(t, ent{name: "app", typ: tar.TypeSymlink, link: "/nowhere"})}
	}}
	g.install(t)
	if _, _, err := List(bg, "tugra_a", "/app"); code(err) != "not_dir" {
		t.Fatalf("%v", err)
	}
	if len(g.calls) != 2 {
		t.Fatalf("must retry exactly once, got %d calls", len(g.calls))
	}
	// the root's retry spelling is "/."
	h := &fakeDocker{handler: func(c call) reply { return reply{stdout: mkTar(t, ent{name: "x", typ: tar.TypeSymlink, link: "y"})} }}
	h.install(t)
	_, _, _ = List(bg, "tugra_a", "/")
	if len(h.calls) != 2 || h.calls[1].args[1] != "tugra_a:/." {
		t.Fatalf("root retry: %v", h.calls)
	}
}

func TestListNotADirectoryAndErrors(t *testing.T) {
	f := &fakeDocker{handler: func(call) reply { return reply{stdout: mkTar(t, ent{name: "hosts", typ: tar.TypeReg, body: "x"})} }}
	f.install(t)
	if _, _, err := List(bg, "tugra_a", "/etc/hosts"); code(err) != "not_dir" {
		t.Fatalf("%v", err)
	}
	g := &fakeDocker{handler: func(call) reply { return reply{stderr: "No such container: tugra_a", err: exitErr{1}} }}
	g.install(t)
	if _, _, err := List(bg, "tugra_a", "/app"); code(err) != "not_running" {
		t.Fatalf("%v", err)
	}
	h := &fakeDocker{handler: func(call) reply { return reply{} }}
	h.install(t)
	if _, _, err := List(bg, "tugra_a", "/app"); code(err) != "not_found" {
		t.Fatalf("%v", err)
	}
}

func TestListBudgets(t *testing.T) {
	var ents []ent
	ents = append(ents, ent{name: "d/", typ: tar.TypeDir})
	for i := 0; i < 60; i++ {
		ents = append(ents, ent{name: "d/f" + string(rune('A'+i%26)) + string(rune('a'+i/26)), typ: tar.TypeReg, body: "x"})
	}
	tarball := mkTar(t, ents...)

	// header budget
	oh := listMaxHeaders
	listMaxHeaders = 10
	f := &fakeDocker{handler: func(call) reply { return reply{stdout: tarball} }}
	f.install(t)
	es, trunc, err := List(bg, "tugra_a", "/d")
	listMaxHeaders = oh
	if err != nil || !trunc || len(es) == 0 || len(es) >= 60 {
		t.Fatalf("header budget: %d entries trunc=%v err=%v", len(es), trunc, err)
	}
	if f.killed == 0 {
		t.Error("the CLI must be killed when a budget is hit")
	}

	// entry cap
	oe := maxListEntries
	maxListEntries = 5
	es, trunc, _ = List(bg, "tugra_a", "/d")
	maxListEntries = oe
	if !trunc || len(es) != 5 {
		t.Fatalf("entry cap: %d trunc=%v", len(es), trunc)
	}

	// byte budget: cut the stream mid-way
	ob := listMaxBytes
	listMaxBytes = 2048
	es, trunc, err = List(bg, "tugra_a", "/d")
	listMaxBytes = ob
	if err != nil || !trunc || len(es) >= 60 {
		t.Fatalf("byte budget: %d trunc=%v err=%v", len(es), trunc, err)
	}
}

func TestListWallClockBudget(t *testing.T) {
	ow := listMaxWall
	listMaxWall = 50 * time.Millisecond
	defer func() { listMaxWall = ow }()
	orig := start
	defer func() { start = orig }()
	start = func(ctx context.Context, stdin io.Reader, args ...string) (*proc, error) {
		first := mkTar(t, ent{name: "d/", typ: tar.TypeDir}, ent{name: "d/a", typ: tar.TypeReg, body: "x"})
		pr, pw := io.Pipe()
		go func() {
			_, _ = pw.Write(first[:1024]) // dir header + a's header + body padding... then stall forever
			<-ctx.Done()
			_ = pw.CloseWithError(ctx.Err())
		}()
		return &proc{Stdout: pr, Wait: func() error { return ctx.Err() }, Stderr: func() string { return "" }, Kill: func() {}}, nil
	}
	done := make(chan struct{})
	var es int
	var trunc bool
	var err error
	go func() {
		defer close(done)
		r, tr, er := List(bg, "tugra_a", "/d")
		es, trunc, err = len(r), tr, er
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("a stalled listing outlived its wall-clock budget")
	}
	if err != nil || !trunc {
		t.Fatalf("es=%d trunc=%v err=%v", es, trunc, err)
	}
}

func TestListHostileArchives(t *testing.T) {
	// names with "..", absolute names, NULs and backslashes are never reported as children
	tarball := mkTar(t,
		ent{name: "d/", typ: tar.TypeDir},
		ent{name: "d/ok", typ: tar.TypeReg, body: "x"},
		ent{name: "d/../evil", typ: tar.TypeReg, body: "x"},
		ent{name: "../evil2", typ: tar.TypeReg, body: "x"},
		ent{name: "/etc/passwd", typ: tar.TypeReg, body: "x"},
		ent{name: "d/we\\ird", typ: tar.TypeReg, body: "x"},
		ent{name: "other/x", typ: tar.TypeReg, body: "x"},
	)
	f := &fakeDocker{handler: func(call) reply { return reply{stdout: tarball} }}
	f.install(t)
	es, _, err := List(bg, "tugra_a", "/d")
	if err != nil || len(es) != 1 || es[0].Name != "ok" {
		t.Fatalf("%v %v", es, err)
	}
}

func TestListGiantPaxHeaderIsContained(t *testing.T) {
	// A PAX extended header claiming 3 MiB: the stdlib reader refuses special files over 1 MiB, so it can never be
	// buffered whole. Hand-built because the stdlib writer will not emit it.
	giant := append(rawHeader("d/pax", 'x', []byte(oct(3<<20)+"\x00")), make([]byte, 3<<20)...)
	good := mkTar(t, ent{name: "d/", typ: tar.TypeDir})
	good = good[:512] // just the dir header
	archive := append(append([]byte{}, good...), giant...)
	f := &fakeDocker{handler: func(call) reply { return reply{stdout: archive} }}
	f.install(t)
	es, trunc, err := List(bg, "tugra_a", "/d")
	if err != nil || !trunc || len(es) != 0 {
		t.Fatalf("giant PAX record: es=%v trunc=%v err=%v", es, trunc, err)
	}
	// ...and as the FIRST header it is an unreadable archive, not a crash or a huge allocation
	g := &fakeDocker{handler: func(call) reply { return reply{stdout: giant} }}
	g.install(t)
	if _, _, err := List(bg, "tugra_a", "/d"); code(err) != "failed" {
		t.Fatalf("%v", err)
	}
	if _, err := Stat(bg, "tugra_a", "/d"); code(err) != "failed" {
		t.Fatalf("stat: %v", err)
	}
}

// rawTar hand-builds a tar with an arbitrary size field (the stdlib writer refuses negative sizes).
func rawHeader(name string, typeflag byte, sizeField []byte) []byte {
	h := make([]byte, 512)
	copy(h[0:], name)
	copy(h[100:], "0000644\x00")
	copy(h[108:], "0000000\x00")
	copy(h[116:], "0000000\x00")
	copy(h[124:], sizeField)
	copy(h[136:], "00000000000\x00")
	h[156] = typeflag
	copy(h[257:], "ustar\x0000")
	for i := 148; i < 156; i++ {
		h[i] = ' '
	}
	sum := 0
	for _, c := range h {
		sum += int(c)
	}
	copy(h[148:], []byte(strings.Repeat("0", 6-len(oct(sum)))+oct(sum)+"\x00 "))
	return h
}

func oct(n int) string {
	if n == 0 {
		return "0"
	}
	var s []byte
	for n > 0 {
		s = append([]byte{byte('0' + n%8)}, s...)
		n /= 8
	}
	return string(s)
}

func TestNegativeSizeHeaderIsRejected(t *testing.T) {
	neg := make([]byte, 12)
	neg[0] = 0xff // base-256 negative number
	for i := 1; i < 12; i++ {
		neg[i] = 0xff
	}
	archive := append(rawHeader("d/", '5', []byte("00000000000\x00")), rawHeader("d/x", '0', neg)...)
	archive = append(archive, make([]byte, 1024)...)
	f := &fakeDocker{handler: func(call) reply { return reply{stdout: archive} }}
	f.install(t)
	es, trunc, err := List(bg, "tugra_a", "/d")
	if err != nil || !trunc || len(es) != 0 {
		t.Fatalf("negative size: es=%v trunc=%v err=%v", es, trunc, err)
	}
	// as a Stat header it is an unreadable archive
	g := &fakeDocker{handler: func(call) reply { return reply{stdout: append(rawHeader("x", '0', neg), make([]byte, 1024)...)} }}
	g.install(t)
	if _, err := Stat(bg, "tugra_a", "/x"); code(err) != "failed" {
		t.Fatalf("%v", err)
	}
}

// ── ReadTo ───────────────────────────────────────────────────────────────────────────────────────────────────

func TestReadToStreamsExactlyAndKillsTheCLI(t *testing.T) {
	tarball := mkTar(t, ent{name: "hosts", typ: tar.TypeReg, body: "hello world"})
	f := &fakeDocker{handler: func(call) reply { return reply{stdout: tarball} }}
	f.install(t)
	var out bytes.Buffer
	if err := ReadTo(bg, "tugra_a", "/etc/hosts", 11, &out); err != nil || out.String() != "hello world" {
		t.Fatalf("%v %q", err, out.String())
	}
	if f.killed == 0 {
		t.Error("CLI must be killed once the bytes are out")
	}
}

func TestReadToRefusals(t *testing.T) {
	cases := []struct {
		name string
		tar  []byte
		size int64
		want string
	}{
		{"wrong size", mkTar(t, ent{name: "f", typ: tar.TypeReg, body: "12345"}), 4, "changed"},
		{"directory", mkTar(t, ent{name: "d/", typ: tar.TypeDir}), 0, "is_dir"},
		{"symlink", mkTar(t, ent{name: "l", typ: tar.TypeSymlink, link: "x"}), 0, "not_regular"},
		{"fifo", mkTar(t, ent{name: "p", typ: tar.TypeFifo}), 0, "not_regular"},
	}
	for _, c := range cases {
		f := &fakeDocker{handler: func(call) reply { return reply{stdout: c.tar} }}
		f.install(t)
		var out bytes.Buffer
		if err := ReadTo(bg, "tugra_a", "/x", c.size, &out); code(err) != c.want {
			t.Errorf("%s: %v", c.name, err)
		}
		if out.Len() != 0 {
			t.Errorf("%s: bytes leaked before refusal", c.name)
		}
	}
	// a body that ends early
	short := mkTar(t, ent{name: "f", typ: tar.TypeReg, body: "12345"})
	cut := short[:512+3] // header + 3 of 5 bytes
	f := &fakeDocker{handler: func(call) reply { return reply{stdout: cut} }}
	f.install(t)
	if err := ReadTo(bg, "tugra_a", "/x", 5, io.Discard); code(err) == "" {
		t.Error("a truncated body must fail")
	}
	if err := ReadTo(bg, "nginx", "/x", 5, io.Discard); code(err) != "bad_request" {
		t.Error("bad name")
	}
}

// ── Write ────────────────────────────────────────────────────────────────────────────────────────────────────

func sum(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

// ctrWorld is a tiny fake container filesystem: stat via `cp NAME:/p -`, writes via `cp -a - NAME:/parent`.
type ctrWorld struct {
	t       *testing.T
	entries map[string]ent
	writes  []call
	stderr  string
	err     error
}

func (w *ctrWorld) handler(c call) reply {
	if len(c.args) >= 3 && c.args[0] == "cp" && c.args[1] == "-a" {
		w.writes = append(w.writes, c)
		if w.err != nil {
			return reply{stderr: w.stderr, err: w.err}
		}
		return reply{}
	}
	if len(c.args) == 3 && c.args[0] == "cp" && c.args[2] == "-" {
		p := strings.SplitN(c.args[1], ":", 2)[1]
		if e, ok := w.entries[p]; ok {
			e.name = filepath.Base(p)
			if e.typ == tar.TypeDir {
				e.name += "/"
			}
			return reply{stdout: mkTar(w.t, e)}
		}
		return reply{stderr: "Error response from daemon: Could not find the file " + p + " in container tugra_a", err: exitErr{1}}
	}
	w.t.Fatalf("unexpected docker call %v", c.args)
	return reply{}
}

func readTarEntry(t *testing.T, b []byte) (*tar.Header, string) {
	t.Helper()
	tr := tar.NewReader(bytes.NewReader(b))
	h, err := tr.Next()
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(tr)
	return h, string(body)
}

func withStage(t *testing.T) string {
	t.Helper()
	old := StageDir
	StageDir = filepath.Join(t.TempDir(), "fsx")
	t.Cleanup(func() { StageDir = old })
	return StageDir
}

func TestWriteCreateInheritsParentOwnerAndVerifiesBeforeTouchingTheContainer(t *testing.T) {
	stage := withStage(t)
	w := &ctrWorld{t: t, entries: map[string]ent{"/app": {typ: tar.TypeDir, mode: 0o755, uid: 1000, gid: 1001}}}
	f := &fakeDocker{handler: w.handler}
	f.install(t)

	res, err := Write(bg, "tugra_a", "/app/config.json", WriteOpts{Size: 5, Sha256: sum("hello")}, strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created || res.Bytes != 5 || res.Sha256 != sum("hello") {
		t.Fatalf("%+v", res)
	}
	if len(w.writes) != 1 {
		t.Fatalf("writes %d", len(w.writes))
	}
	if got := strings.Join(w.writes[0].args, " "); got != "cp -a - tugra_a:/app" {
		t.Fatalf("argv %q", got)
	}
	h, body := readTarEntry(t, w.writes[0].stdin)
	if h.Name != "config.json" || h.Size != 5 || h.Mode != 0o644 || h.Uid != 1000 || h.Gid != 1001 || h.Typeflag != tar.TypeReg || body != "hello" {
		t.Fatalf("tar entry %+v body %q", h, body)
	}
	if es, _ := os.ReadDir(stage); len(es) != 0 {
		t.Fatalf("staged file left behind: %v", es)
	}
}

func TestWriteVerifiesTheStagedHashBeforeAnyMutatingDockerCall(t *testing.T) {
	withStage(t)
	w := &ctrWorld{t: t, entries: map[string]ent{"/app": {typ: tar.TypeDir, mode: 0o755}}}
	f := &fakeDocker{handler: w.handler}
	f.install(t)
	_, err := Write(bg, "tugra_a", "/app/x", WriteOpts{Size: 5, Sha256: strings.Repeat("0", 64)}, strings.NewReader("hello"))
	if code(err) != "integrity" {
		t.Fatalf("%v", err)
	}
	if len(w.writes) != 0 {
		t.Fatal("a bad hash reached the container")
	}
	for _, body := range []string{"hel", "hello!!"} {
		if _, err := Write(bg, "tugra_a", "/app/x", WriteOpts{Size: 5}, strings.NewReader(body)); code(err) != "bad_request" {
			t.Fatalf("%q: %v", body, err)
		}
	}
	if len(w.writes) != 0 {
		t.Fatal("a wrong-length body reached the container")
	}
}

func TestWriteOverwriteKeepsOwnerAndModeUnlessAsked(t *testing.T) {
	withStage(t)
	w := &ctrWorld{t: t, entries: map[string]ent{
		"/app":      {typ: tar.TypeDir, mode: 0o755, uid: 1000, gid: 1000},
		"/app/f.sh": {typ: tar.TypeReg, mode: 0o750, uid: 33, gid: 34, body: "old"},
	}}
	f := &fakeDocker{handler: w.handler}
	f.install(t)
	res, err := Write(bg, "tugra_a", "/app/f.sh", WriteOpts{Overwrite: true, Size: 3, Sha256: sum("new")}, strings.NewReader("new"))
	if err != nil || res.Created {
		t.Fatalf("%v %+v", err, res)
	}
	h, _ := readTarEntry(t, w.writes[0].stdin)
	if h.Uid != 33 || h.Gid != 34 || h.Mode != 0o750 {
		t.Fatalf("overwrite changed owner/mode: %+v", h)
	}
	if _, err := Write(bg, "tugra_a", "/app/f.sh", WriteOpts{Overwrite: true, HasMode: true, Mode: 0o600, Size: 3}, strings.NewReader("new")); err != nil {
		t.Fatal(err)
	}
	h, _ = readTarEntry(t, w.writes[1].stdin)
	if h.Mode != 0o600 {
		t.Fatalf("requested mode ignored: %+v", h)
	}
}

func TestWritePreflightRefusals(t *testing.T) {
	withStage(t)
	cases := []struct {
		name string
		ents map[string]ent
		o    WriteOpts
		want string
	}{
		{"exists", map[string]ent{"/app": {typ: tar.TypeDir}, "/app/f": {typ: tar.TypeReg, body: "x"}}, WriteOpts{Size: 1}, "exists"},
		{"is dir", map[string]ent{"/app": {typ: tar.TypeDir}, "/app/f": {typ: tar.TypeDir}}, WriteOpts{Overwrite: true, Size: 1}, "is_dir"},
		{"symlink", map[string]ent{"/app": {typ: tar.TypeDir}, "/app/f": {typ: tar.TypeSymlink, link: "/etc/passwd"}}, WriteOpts{Overwrite: true, Size: 1}, "not_regular"},
		{"stale etag", map[string]ent{"/app": {typ: tar.TypeDir}, "/app/f": {typ: tar.TypeReg, body: "x"}}, WriteOpts{Overwrite: true, Size: 1, IfMatch: "9-9"}, "changed"},
		{"etag but gone", map[string]ent{"/app": {typ: tar.TypeDir}}, WriteOpts{Overwrite: true, Size: 1, IfMatch: "1-1"}, "changed"},
		{"parent missing", map[string]ent{}, WriteOpts{Size: 1}, "not_found"},
		{"parent is a file", map[string]ent{"/app": {typ: tar.TypeReg, body: "x"}}, WriteOpts{Size: 1}, "not_dir"},
	}
	for _, c := range cases {
		w := &ctrWorld{t: t, entries: c.ents}
		f := &fakeDocker{handler: w.handler}
		f.install(t)
		if _, err := Write(bg, "tugra_a", "/app/f", c.o, strings.NewReader("x")); code(err) != c.want {
			t.Errorf("%s: %v", c.name, err)
		}
		if len(w.writes) != 0 {
			t.Errorf("%s: refused write still reached the container", c.name)
		}
	}
}

func TestWriteMapsDaemonErrors(t *testing.T) {
	withStage(t)
	for stderr, want := range map[string]string{
		"Error response from daemon: Error processing tar file(exit status 1): open /app/f: read-only file system": "read_only",
		"Error response from daemon: Error processing tar file: permission denied":                                 "denied",
		"Error response from daemon: No such container: tugra_a":                                                   "not_running",
	} {
		w := &ctrWorld{t: t, entries: map[string]ent{"/app": {typ: tar.TypeDir}}, stderr: stderr, err: exitErr{1}}
		f := &fakeDocker{handler: w.handler}
		f.install(t)
		if _, err := Write(bg, "tugra_a", "/app/f", WriteOpts{Size: 1}, strings.NewReader("x")); code(err) != want {
			t.Errorf("%q -> %v", stderr, err)
		}
	}
}

func TestWriteRefusesWhenTheAgentCannotStageTheBody(t *testing.T) {
	withStage(t)
	w := &ctrWorld{t: t, entries: map[string]ent{"/app": {typ: tar.TypeDir}}}
	f := &fakeDocker{handler: w.handler}
	f.install(t)
	// a body bigger than the free space (+ headroom) is refused as no_space before a byte is read or the container touched
	_, err := Write(bg, "tugra_a", "/app/big", WriteOpts{Size: 1 << 60}, strings.NewReader("x"))
	if code(err) != "no_space" {
		t.Fatalf("%v", err)
	}
	if len(w.writes) != 0 {
		t.Fatal("container touched")
	}
}

func TestWriteRejectsBadTargets(t *testing.T) {
	withStage(t)
	f := &fakeDocker{handler: func(call) reply { t.Fatal("docker must not run"); return reply{} }}
	f.install(t)
	for _, p := range []string{"/", "/proc/x", "/a/../b", "rel"} {
		if _, err := Write(bg, "tugra_a", p, WriteOpts{Size: 1}, strings.NewReader("x")); code(err) != "bad_request" {
			t.Errorf("%q: %v", p, err)
		}
	}
}

func TestSweepStageRemovesOnlyOldOwnFiles(t *testing.T) {
	stage := withStage(t)
	_ = os.MkdirAll(stage, 0o700)
	mk := func(n string, age time.Duration) {
		p := filepath.Join(stage, n)
		_ = os.WriteFile(p, []byte("x"), 0o600)
		ts := time.Now().Add(-age)
		_ = os.Chtimes(p, ts, ts)
	}
	mk(strings.Repeat("a", 32), 2*time.Hour)
	mk(strings.Repeat("b", 32), time.Minute)
	mk("not-ours.txt", 2*time.Hour)
	if n := SweepStage(time.Hour); n != 1 {
		t.Fatalf("removed %d", n)
	}
	left, _ := os.ReadDir(stage)
	if len(left) != 2 {
		t.Fatalf("%v", left)
	}
}

// ── Mkdir ────────────────────────────────────────────────────────────────────────────────────────────────────

func TestMkdirCreatesEachMissingLevelOwnedLikeItsAncestor(t *testing.T) {
	w := &ctrWorld{t: t, entries: map[string]ent{
		"/":    {typ: tar.TypeDir, mode: 0o755},
		"/app": {typ: tar.TypeDir, mode: 0o755, uid: 1000, gid: 1001},
	}}
	f := &fakeDocker{handler: w.handler}
	f.install(t)
	if err := Mkdir(bg, "tugra_a", "/app/a/b", 0o750, true); err != nil {
		t.Fatal(err)
	}
	if len(w.writes) != 2 {
		t.Fatalf("writes %d", len(w.writes))
	}
	// intermediate levels stay traversable (0755); only the leaf takes the requested mode
	for i, want := range []struct {
		dest, entry string
		mode        int64
	}{{"tugra_a:/app", "a/", 0o755}, {"tugra_a:/app/a", "b/", 0o750}} {
		if got := strings.Join(w.writes[i].args, " "); got != "cp -a - "+want.dest {
			t.Fatalf("argv %q", got)
		}
		h, _ := readTarEntry(t, w.writes[i].stdin)
		if h.Name != want.entry || h.Typeflag != tar.TypeDir || h.Mode != want.mode || h.Uid != 1000 || h.Gid != 1001 {
			t.Fatalf("entry %+v", h)
		}
	}
}

func TestMkdirRefusals(t *testing.T) {
	w := &ctrWorld{t: t, entries: map[string]ent{"/": {typ: tar.TypeDir}, "/app": {typ: tar.TypeDir}, "/app/x": {typ: tar.TypeDir}, "/app/file": {typ: tar.TypeReg, body: "x"}}}
	f := &fakeDocker{handler: w.handler}
	f.install(t)
	if err := Mkdir(bg, "tugra_a", "/app/x", 0o755, false); code(err) != "exists" {
		t.Errorf("exists: %v", err)
	}
	if err := Mkdir(bg, "tugra_a", "/app/x", 0o755, true); err != nil {
		t.Errorf("mkdir -p on an existing dir: %v", err)
	}
	if err := Mkdir(bg, "tugra_a", "/app/file", 0o755, true); code(err) != "exists" {
		t.Errorf("over a file: %v", err)
	}
	if err := Mkdir(bg, "tugra_a", "/app/file/sub", 0o755, true); code(err) != "not_dir" {
		t.Errorf("through a file: %v", err)
	}
	if err := Mkdir(bg, "tugra_a", "/app/a/b", 0o755, false); code(err) != "not_found" {
		t.Errorf("missing parent without -p: %v", err)
	}
	if err := Mkdir(bg, "tugra_a", "/app/z", 0o4755, false); code(err) != "bad_request" {
		t.Errorf("setuid: %v", err)
	}
	if err := Mkdir(bg, "tugra_a", "/", 0o755, true); code(err) != "bad_request" {
		t.Errorf("root: %v", err)
	}
	if len(w.writes) != 0 {
		t.Errorf("a refused mkdir reached the container: %d", len(w.writes))
	}
	if err := Mkdir(bg, "tugra_a", "/app/ok", 0o755, false); err != nil || len(w.writes) != 1 {
		t.Errorf("plain mkdir: %v %d", err, len(w.writes))
	}
}

// ── ExecOp ───────────────────────────────────────────────────────────────────────────────────────────────────

type execWorld struct {
	ctrWorld
	execs []call
	reply reply
}

func (w *execWorld) handler(c call) reply {
	if len(c.args) > 0 && c.args[0] == "exec" {
		w.execs = append(w.execs, c)
		return w.reply
	}
	return w.ctrWorld.handler(c)
}

func newExec(t *testing.T, ents map[string]ent) (*execWorld, *fakeDocker) {
	w := &execWorld{ctrWorld: ctrWorld{t: t, entries: ents}}
	f := &fakeDocker{handler: w.handler}
	f.install(t)
	return w, f
}

func TestExecOpExactArgvNoShell(t *testing.T) {
	ents := map[string]ent{"/app/f": {typ: tar.TypeReg, body: "x"}, "/app/d": {typ: tar.TypeDir}, "/app/l": {typ: tar.TypeSymlink, link: "f"}}
	cases := []struct {
		op, a, b, mode string
		rec            bool
		want           string
	}{
		{"rename", "/app/f", "/app/g", "", false, "exec -w / tugra_a mv -- /app/f /app/g"},
		{"chmod", "/app/f", "", "644", false, "exec -w / tugra_a chmod 0644 -- /app/f"},
		{"chmod", "/app/d", "", "0750", false, "exec -w / tugra_a chmod 0750 -- /app/d"},
		{"delete", "/app/f", "", "", false, "exec -w / tugra_a rm -- /app/f"},
		{"delete", "/app/l", "", "", false, "exec -w / tugra_a rm -- /app/l"},
		{"delete", "/app/d", "", "", false, "exec -w / tugra_a rmdir -- /app/d"},
		{"delete", "/app/d", "", "", true, "exec -w / tugra_a rm -r -- /app/d"},
	}
	for _, c := range cases {
		w, _ := newExec(t, ents)
		if err := ExecOp(bg, "tugra_a", c.op, c.a, c.b, c.mode, c.rec); err != nil {
			t.Fatalf("%s: %v", c.want, err)
		}
		if len(w.execs) != 1 || strings.Join(w.execs[0].args, " ") != c.want {
			t.Fatalf("argv %v want %q", w.execs, c.want)
		}
		// hygiene: nothing is -i/-t/--user/--privileged/env, and no shell
		for _, a := range w.execs[0].args {
			switch a {
			case "-i", "-t", "-it", "--user", "-u", "--privileged", "-e", "--env", "sh", "bash", "-c":
				t.Fatalf("forbidden token %q in %v", a, w.execs[0].args)
			}
		}
	}
}

func TestExecOpRefusals(t *testing.T) {
	ents := map[string]ent{"/app/f": {typ: tar.TypeReg, body: "x"}, "/app/g": {typ: tar.TypeReg, body: "y"}, "/app/d": {typ: tar.TypeDir}}
	cases := []struct {
		name           string
		op, a, b, mode string
		want           string
	}{
		{"rename onto existing file", "rename", "/app/f", "/app/g", "", "exists"},
		{"rename INTO existing dir", "rename", "/app/f", "/app/d", "", "exists"},
		{"rename into itself", "rename", "/app/d", "/app/d/x", "", "bad_request"},
		{"rename missing source", "rename", "/app/nope", "/app/z", "", "not_found"},
		{"rename root", "rename", "/", "/z", "", "bad_request"},
		{"chmod setuid", "chmod", "/app/f", "", "4755", "bad_request"},
		{"chmod no mode", "chmod", "/app/f", "", "", "bad_request"},
		{"chmod missing", "chmod", "/app/nope", "", "644", "not_found"},
		{"delete missing", "delete", "/app/nope", "", "", "not_found"},
		{"delete root", "delete", "/", "", "", "bad_request"},
		{"delete proc", "delete", "/proc/1", "", "", "bad_request"},
		{"unknown op", "exec", "/app/f", "", "", "bad_request"},
	}
	for _, c := range cases {
		w, _ := newExec(t, ents)
		if err := ExecOp(bg, "tugra_a", c.op, c.a, c.b, c.mode, false); code(err) != c.want {
			t.Errorf("%s: %v", c.name, err)
		}
		if len(w.execs) != 0 {
			t.Errorf("%s: a refused op executed", c.name)
		}
	}
}

func TestExecOpFailureMapping(t *testing.T) {
	ents := map[string]ent{"/app/f": {typ: tar.TypeReg, body: "x"}, "/app/d": {typ: tar.TypeDir}}
	cases := []struct {
		name string
		op   string
		path string
		r    reply
		want string
	}{
		{"exit 127", "delete", "/app/f", reply{stderr: "OCI runtime exec failed: exec: \"rm\": executable file not found", err: exitErr{127}}, "no_binary"},
		{"exit 126", "chmod", "/app/f", reply{err: exitErr{126}}, "no_binary"},
		{"stopped", "delete", "/app/f", reply{stderr: "Error response from daemon: container abc is not running", err: exitErr{1}}, "not_running"},
		{"rmdir not empty", "delete", "/app/d", reply{stderr: "rmdir: failed to remove '/app/d': Directory not empty", err: exitErr{1}}, "not_empty"},
		{"read-only", "delete", "/app/f", reply{stderr: "rm: cannot remove '/app/f': Read-only file system", err: exitErr{1}}, "read_only"},
		{"permission", "delete", "/app/f", reply{stderr: "rm: cannot remove '/app/f': Permission denied", err: exitErr{1}}, "denied"},
		{"other", "delete", "/app/f", reply{stderr: strings.Repeat("x", 500), err: exitErr{2}}, "failed"},
	}
	for _, c := range cases {
		w, _ := newExec(t, ents)
		w.reply = c.r
		err := ExecOp(bg, "tugra_a", c.op, c.path, "", "644", false)
		if code(err) != c.want {
			t.Errorf("%s: %v", c.name, err)
		}
		var te *fsd.Error
		if c.want == "failed" && (!errors.As(err, &te) || len(te.Msg) > 200) {
			t.Errorf("failed message must be capped at 200 chars: %v", err)
		}
	}
}

func TestEveryArgvElementIsSafeFromOptionParsing(t *testing.T) {
	ents := map[string]ent{"/-rf": {typ: tar.TypeReg, body: "x"}, "/": {typ: tar.TypeDir}}
	w, f := newExec(t, ents)
	if err := ExecOp(bg, "tugra_a", "delete", "/-rf", "", "", false); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.calls {
		// after the container name, every user-controlled element starts with "/" (or is one of our fixed tokens)
		for i, a := range c.args {
			if strings.HasPrefix(a, "-") && !(a == "-w" || a == "--" || a == "-a" || a == "-" || a == "-r") {
				t.Fatalf("option-looking element %q at %d in %v", a, i, c.args)
			}
		}
	}
	if len(w.execs) != 1 {
		t.Fatal("exec not run")
	}
}
