//go:build dockerit

package ctrfs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/fsd"
)

// Real-docker container-filesystem tests (FILES-6 gate). Build tag `dockerit`; needs a Docker daemon and the agent
// image in TUGRA_AGENT_IMAGE (it ships coreutils/bash, so it doubles as a plain "app" container). These tests are
// also the recorded lab result for the `docker cp` behaviours the parsers depend on (spike 2): the root/dir tar
// naming, -a ownership, stopped containers, read-only rootfs and tmpfs, symlink final components.

func itImage(t *testing.T) string {
	t.Helper()
	img := os.Getenv("TUGRA_AGENT_IMAGE")
	if img == "" {
		t.Skip("TUGRA_AGENT_IMAGE not set")
	}
	return img
}

func dk(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// itContainer starts a long-lived container named tugra_it_<rand> (a valid managed-container name) and removes it
// when the test ends. extra are docker-run flags placed before the image.
func itContainer(t *testing.T, img string, extra ...string) string {
	t.Helper()
	name := "tugra_it_" + randName()[:12]
	args := append([]string{"run", "-d", "--name", name}, extra...)
	args = append(args, "--entrypoint", "sleep", img, "600")
	dk(t, args...)
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	return name
}

func ex(t *testing.T, name, script string) string {
	t.Helper()
	return dk(t, "exec", name, "bash", "-c", script)
}

func ctx(t *testing.T) context.Context {
	t.Helper()
	c, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	return c
}

func code2(err error) string {
	var te *fsd.Error
	if errors.As(err, &te) {
		return te.Code
	}
	if err == nil {
		return ""
	}
	return "untyped:" + err.Error()
}

func sha(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func TestIntegrationRunningContainerRoundTrip(t *testing.T) {
	img := itImage(t)
	name := itContainer(t, img)
	ex(t, name, "mkdir -p /srv/app && chown 1234:4321 /srv/app && echo hello > /srv/app/a.txt && chown 1234:4321 /srv/app/a.txt && chmod 640 /srv/app/a.txt && ln -s a.txt /srv/app/link")
	c := ctx(t)

	// list: direct children only; names are the entry basenames
	es, trunc, err := List(c, name, "/srv/app")
	if err != nil || trunc {
		t.Fatalf("list: %v trunc=%v", err, trunc)
	}
	got := map[string]string{}
	for _, e := range es {
		got[e.Name] = e.Type
	}
	if got["a.txt"] != "file" || got["link"] != "symlink" || len(got) != 2 {
		t.Fatalf("list /srv/app = %v", got)
	}

	// stat: mode/uid/gid/size from the first header; a symlink is reported, never followed
	st, err := Stat(c, name, "/srv/app/a.txt")
	if err != nil || st.Type != "file" || st.Size != 6 || st.Mode != "0640" || st.UID != 1234 || st.GID != 4321 {
		t.Fatalf("stat: %+v %v", st, err)
	}
	if ls, err := Stat(c, name, "/srv/app/link"); err != nil || ls.Type != "symlink" || ls.LinkTarget != "a.txt" {
		t.Fatalf("stat symlink: %+v %v", ls, err)
	}
	var buf bytes.Buffer
	if err := ReadTo(c, name, "/srv/app/a.txt", 6, &buf); err != nil || buf.String() != "hello\n" {
		t.Fatalf("read: %v %q", err, buf.String())
	}
	if err := ReadTo(c, name, "/srv/app/link", 0, &buf); code2(err) != "not_regular" {
		t.Fatalf("read through a symlink: %v", err)
	}
	if err := ReadTo(c, name, "/srv/app", 0, &buf); code2(err) != "is_dir" {
		t.Fatalf("read a dir: %v", err)
	}
	if err := ReadTo(c, name, "/srv/app/a.txt", 5, &buf); code2(err) != "changed" {
		t.Fatalf("read with a wrong size: %v", err)
	}

	// write: a NEW file inherits the parent's owner (docker cp -a ownership), a replaced one keeps its own
	res, err := Write(c, name, "/srv/app/new.txt", WriteOpts{Size: 5, Sha256: sha("fresh")}, strings.NewReader("fresh"))
	if err != nil || !res.Created {
		t.Fatalf("write new: %+v %v", res, err)
	}
	if got := ex(t, name, "stat -c '%u:%g %a' /srv/app/new.txt && cat /srv/app/new.txt"); got != "1234:4321 644\nfresh" {
		t.Fatalf("new file = %q", got)
	}
	if _, err := Write(c, name, "/srv/app/new.txt", WriteOpts{Size: 1}, strings.NewReader("x")); code2(err) != "exists" {
		t.Fatalf("no-overwrite: %v", err)
	}
	if _, err := Write(c, name, "/srv/app/a.txt", WriteOpts{Overwrite: true, Size: 3, Sha256: sha("new")}, strings.NewReader("new")); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	if got := ex(t, name, "stat -c '%u:%g %a' /srv/app/a.txt && cat /srv/app/a.txt"); got != "1234:4321 640\nnew" {
		t.Fatalf("overwritten file = %q", got)
	}
	if _, err := Write(c, name, "/srv/app/link", WriteOpts{Overwrite: true, Size: 1}, strings.NewReader("x")); code2(err) != "not_regular" {
		t.Fatalf("write over a symlink: %v", err)
	}
	if _, err := Write(c, name, "/srv/app/x", WriteOpts{Size: 5, Sha256: strings.Repeat("0", 64)}, strings.NewReader("hello")); code2(err) != "integrity" {
		t.Fatalf("hash mismatch: %v", err)
	}
	if got := ex(t, name, "ls /srv/app"); strings.Contains(got, "\nx\n") || strings.HasSuffix(got, "\nx") {
		t.Fatalf("a rejected write left a file: %q", got)
	}

	// mkdir -p: every level owned like its nearest existing ancestor
	if err := Mkdir(c, name, "/srv/app/d1/d2", 0o750, true); err != nil {
		t.Fatalf("mkdir -p: %v", err)
	}
	if got := ex(t, name, "stat -c '%n %u:%g %a' /srv/app/d1 /srv/app/d1/d2"); got != "/srv/app/d1 1234:4321 750\n/srv/app/d1/d2 1234:4321 750" {
		t.Fatalf("mkdir -p = %q", got)
	}
	if err := Mkdir(c, name, "/srv/app/d1", 0o755, false); code2(err) != "exists" {
		t.Fatalf("mkdir over existing: %v", err)
	}

	// exec ops: rename / chmod / delete
	if err := ExecOp(c, name, "rename", "/srv/app/new.txt", "/srv/app/d1/moved.txt", "", false); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if err := ExecOp(c, name, "rename", "/srv/app/a.txt", "/srv/app/d1", "", false); code2(err) != "exists" {
		t.Fatalf("rename INTO an existing dir must be refused: %v", err)
	}
	if err := ExecOp(c, name, "chmod", "/srv/app/d1/moved.txt", "", "600", false); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	if got := ex(t, name, "stat -c %a /srv/app/d1/moved.txt"); got != "600" {
		t.Fatalf("mode = %s", got)
	}
	if err := ExecOp(c, name, "delete", "/srv/app/d1", "", "", false); code2(err) != "not_empty" {
		t.Fatalf("rmdir of a non-empty dir: %v", err)
	}
	if err := ExecOp(c, name, "delete", "/srv/app/d1", "", "", true); err != nil {
		t.Fatalf("recursive delete: %v", err)
	}
	if err := ExecOp(c, name, "delete", "/srv/app/link", "", "", false); err != nil {
		t.Fatalf("delete a symlink: %v", err)
	}
	if got := ex(t, name, "cat /srv/app/a.txt"); got != "new" {
		t.Fatalf("deleting the link touched its target: %q", got)
	}
}

func TestIntegrationRootAndDirListNaming(t *testing.T) {
	img := itImage(t)
	name := itContainer(t, img)
	c := ctx(t)
	// Lab record (spike 2): how `docker cp CONTAINER:/ -` and `CONTAINER:/etc -` name their entries. The parser is
	// tolerant of the variants; this asserts what it must RETURN and logs the first raw names for the record.
	if h, _, pr, cancel, err := firstHeader(c, name, "/"); err == nil {
		t.Logf("first header of `docker cp %s:/ -` = %q (type %c)", name, h.Name, h.Typeflag)
		kill(c, pr, cancel)
	}
	if h, _, pr, cancel, err := firstHeader(c, name, "/etc"); err == nil {
		t.Logf("first header of `docker cp %s:/etc -` = %q (type %c)", name, h.Name, h.Typeflag)
		kill(c, pr, cancel)
	}
	es, truncated, err := List(c, name, "/")
	if err != nil {
		t.Fatalf("list /: %v", err)
	}
	have := map[string]bool{}
	for _, e := range es {
		have[e.Name] = true
		if strings.Contains(e.Name, "/") {
			t.Fatalf("entry %q is not a direct child", e.Name)
		}
	}
	t.Logf("list / => %d entries, truncated=%v", len(es), truncated)
	for _, want := range []string{"etc", "usr", "bin", "var", "tmp"} {
		if !have[want] && !truncated {
			t.Errorf("/ is missing %q: %v", want, have)
		}
	}
	etc, _, err := List(c, name, "/etc")
	if err != nil {
		t.Fatalf("list /etc: %v", err)
	}
	var found bool
	for _, e := range etc {
		if e.Name == "hostname" {
			found = true
		}
		if strings.Contains(e.Name, "/") || e.Name == "etc" {
			t.Fatalf("/etc entry %q", e.Name)
		}
	}
	if !found {
		t.Errorf("/etc listing has no hostname: %d entries", len(etc))
	}
	// /usr is far bigger than the budgets on a stock image: the listing is honest-partial, never an error
	if _, _, err := List(c, name, "/usr"); err != nil {
		t.Fatalf("list /usr: %v", err)
	}
}

func TestIntegrationStoppedContainer(t *testing.T) {
	img := itImage(t)
	name := itContainer(t, img)
	ex(t, name, "mkdir -p /srv/s && echo data > /srv/s/f")
	dk(t, "stop", "-t", "1", name)
	c := ctx(t)
	// docker cp is daemon-side: it works without a running process
	if st, err := Stat(c, name, "/srv/s/f"); err != nil || st.Type != "file" {
		t.Fatalf("stat on a stopped container: %+v %v", st, err)
	}
	var buf bytes.Buffer
	if err := ReadTo(c, name, "/srv/s/f", 5, &buf); err != nil || buf.String() != "data\n" {
		t.Fatalf("read: %v %q", err, buf.String())
	}
	if _, err := Write(c, name, "/srv/s/g", WriteOpts{Size: 2, Sha256: sha("hi")}, strings.NewReader("hi")); err != nil {
		t.Fatalf("write on a stopped container: %v", err)
	}
	if es, _, err := List(c, name, "/srv/s"); err != nil || len(es) != 2 {
		t.Fatalf("list: %v %v", es, err)
	}
	// exec-backed ops genuinely need a running container
	if err := ExecOp(c, name, "delete", "/srv/s/g", "", "", false); code2(err) != "not_running" {
		t.Fatalf("exec on a stopped container: %v", err)
	}
}

func TestIntegrationCreatedNeverStartedDistrolessContainer(t *testing.T) {
	_ = itImage(t)
	name := "tugra_it_" + randName()[:12]
	dk(t, "create", "--name", name, "gcr.io/distroless/static-debian12")
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	c := ctx(t)
	// distroless: no shell, no coreutils — everything that does not need an exec still works
	if es, _, err := List(c, name, "/"); err != nil || len(es) == 0 {
		t.Fatalf("list on distroless: %v %v", es, err)
	}
	if _, err := Stat(c, name, "/etc/passwd"); err != nil {
		t.Fatalf("stat on distroless: %v", err)
	}
	if err := ExecOp(c, name, "chmod", "/etc/passwd", "", "644", false); code2(err) != "not_running" {
		t.Fatalf("exec on a created container: %v", err)
	}
}

func TestIntegrationMissingBinaryIsNoBinary(t *testing.T) {
	img := itImage(t)
	name := itContainer(t, img)
	ex(t, name, "mkdir -p /srv/b && echo x > /srv/b/f && rm -f /usr/bin/mv /bin/mv")
	c := ctx(t)
	if err := ExecOp(c, name, "rename", "/srv/b/f", "/srv/b/g", "", false); code2(err) != "no_binary" {
		t.Fatalf("rename without mv: %v", err)
	}
	// the other tools still work
	if err := ExecOp(c, name, "chmod", "/srv/b/f", "", "600", false); err != nil {
		t.Fatalf("chmod: %v", err)
	}
}

func TestIntegrationReadOnlyRootfsAndTmpfs(t *testing.T) {
	img := itImage(t)
	name := itContainer(t, img, "--read-only", "--tmpfs", "/scratch")
	c := ctx(t)
	_, err := Write(c, name, "/etc/tugra-it", WriteOpts{Size: 1, Sha256: sha("x")}, strings.NewReader("x"))
	if code := code2(err); code != "read_only" && code != "denied" {
		t.Fatalf("write to a read-only rootfs: %v", err)
	}
	t.Logf("write to a read-only rootfs => %v", err)
	if _, err := Write(c, name, "/scratch/ok", WriteOpts{Size: 1, Sha256: sha("x")}, strings.NewReader("x")); err != nil {
		t.Fatalf("write to a tmpfs inside a read-only container: %v", err)
	}
	if err := ExecOp(c, name, "delete", "/etc/hostname", "", "", false); code2(err) != "read_only" && code2(err) != "denied" {
		t.Fatalf("delete on a read-only rootfs: %v", err)
	}
	if err := ExecOp(c, name, "delete", "/scratch/ok", "", "", false); err != nil {
		t.Fatalf("delete on tmpfs: %v", err)
	}
}

func TestIntegrationMissingContainerAndPaths(t *testing.T) {
	_ = itImage(t)
	c := ctx(t)
	if _, err := Stat(c, "tugra_it_doesnotexist", "/etc"); code2(err) != "not_running" {
		t.Fatalf("missing container: %v", err)
	}
	img := itImage(t)
	name := itContainer(t, img)
	if _, err := Stat(c, name, "/definitely/not/here"); code2(err) != "not_found" {
		t.Fatalf("missing path: %v", err)
	}
	if _, _, err := List(c, name, "/definitely/not/here"); code2(err) != "not_found" {
		t.Fatalf("list of a missing path: %v", err)
	}
}
