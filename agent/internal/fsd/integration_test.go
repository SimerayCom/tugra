//go:build dockerit

package fsd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strings"
	"testing"
	"time"
)

// Real-docker integration tests (FILES-6 gate). They only build with `-tags dockerit` and need a Docker daemon
// plus the agent image in TUGRA_AGENT_IMAGE (CI: `docker build -f deploy/Dockerfile.agent -t tugra-agent:it .`).
// A plain `go test ./...` never compiles this file.

func itImage(t *testing.T) string {
	t.Helper()
	img := os.Getenv("TUGRA_AGENT_IMAGE")
	if img == "" {
		t.Skip("TUGRA_AGENT_IMAGE not set")
	}
	return img
}

func itDocker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// itVolume creates a throwaway named volume and removes it when the test ends.
func itVolume(t *testing.T) string {
	t.Helper()
	name := "tugra_it_" + newContainerName()[len("tugra-fsd-"):]
	itDocker(t, "volume", "create", name)
	t.Cleanup(func() { _ = exec.Command("docker", "volume", "rm", "-f", name).Run() })
	return name
}

// itSeed runs a short shell script as root inside a plain image with the volume mounted at /data, to seed it.
// The agent image is reused (it ships bash) so no extra image has to be pulled.
func itSeed(t *testing.T, img, vol, script string) {
	t.Helper()
	itDocker(t, "run", "--rm", "--entrypoint", "bash", "--mount", "type=volume,src="+vol+",dst=/data", img, "-c", script)
}

// TestIntegrationListExisting proves the gate itself: the pre-existing read-only `fsd list` helper works
// against a real daemon (argv accepted by docker, volume mounted read-only, JSON round-trips).
func TestIntegrationListExisting(t *testing.T) {
	img := itImage(t)
	vol := itVolume(t)
	itSeed(t, img, vol, "cd /data && mkdir -p sub && echo hi > a.txt && ln -s a.txt link && echo x > sub/b")

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	entries, truncated, err := Launch(ctx, img, vol, "list", "")
	if err != nil {
		t.Fatalf("Launch: %v", err)
	}
	if truncated {
		t.Fatal("unexpected truncation")
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name+":"+e.Type)
	}
	sort.Strings(got)
	want := []string{"a.txt:file", "link:symlink", "sub:dir"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("entries = %v, want %v", got, want)
	}

	// An escape attempt is refused by the helper, not by luck.
	if _, _, err := Launch(ctx, img, vol, "list", "sub/../.."); err == nil {
		t.Fatal("expected '..' path to be refused")
	}
}

// ---- fsd2 (write-capable helper) against real named volumes ----

func itCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func itWrite(t *testing.T, img, vol, p, body, flags string) (Result2, error) {
	t.Helper()
	sum := sha256.Sum256([]byte(body))
	return Launch2(itCtx(t), img, vol, Req2{Op: "write", Path: p, Size: int64(len(body)), Sha256: hex.EncodeToString(sum[:]), Flags: flags}, strings.NewReader(body), nil)
}

func itRead(t *testing.T, img, vol, p string, size int64) (string, error) {
	t.Helper()
	var buf bytes.Buffer
	_, err := Launch2(itCtx(t), img, vol, Req2{Op: "read", Path: p, Size: size}, nil, &buf)
	return buf.String(), err
}

func itCode(err error) string {
	var te *Error
	if errors.As(err, &te) {
		return te.Code
	}
	return "untyped:" + fmt.Sprint(err)
}

// itBash runs a script inside the agent image (as the given user, "" = root) with the volume at /data.
func itBash(t *testing.T, img, vol, user, script string) string {
	t.Helper()
	args := []string{"run", "--rm"}
	if user != "" {
		args = append(args, "--user", user)
	}
	args = append(args, "--entrypoint", "bash", "--mount", "type=volume,src="+vol+",dst=/data", img, "-c", script)
	return itDocker(t, args...)
}

func TestIntegrationFsd2FullRoundTrip(t *testing.T) {
	img := itImage(t)
	vol := itVolume(t)

	res, err := itWrite(t, img, vol, "hello.txt", "hello", "")
	if err != nil || !res.Created || res.Bytes != 5 {
		t.Fatalf("write: %+v %v", res, err)
	}
	if got, err := itRead(t, img, vol, "hello.txt", 5); err != nil || got != "hello" {
		t.Fatalf("read: %q %v", got, err)
	}
	if _, err := itWrite(t, img, vol, "hello.txt", "again", ""); itCode(err) != CodeExists {
		t.Fatalf("no-overwrite write: %v", err)
	}
	if res, err = itWrite(t, img, vol, "hello.txt", "world!", "o"); err != nil || res.Created {
		t.Fatalf("overwrite: %+v %v", res, err)
	}
	ctx := itCtx(t)
	if _, err := Launch2(ctx, img, vol, Req2{Op: "mkdir", Path: "a/b/c", Flags: "p"}, nil, nil); err != nil {
		t.Fatalf("mkdir -p: %v", err)
	}
	if _, err := Launch2(ctx, img, vol, Req2{Op: "rename", Path: "hello.txt", Path2: "a/b/c/moved.txt"}, nil, nil); err != nil {
		t.Fatalf("rename: %v", err)
	}
	st, err := Launch2(ctx, img, vol, Req2{Op: "chmod", Path: "a/b/c/moved.txt", Mode: "0600"}, nil, nil)
	if err != nil || st.Stat == nil || st.Stat.Mode != "0600" {
		t.Fatalf("chmod: %+v %v", st, err)
	}
	if _, err := Launch2(ctx, img, vol, Req2{Op: "delete", Path: "a"}, nil, nil); itCode(err) != CodeNotEmpty {
		t.Fatalf("non-recursive delete: %v", err)
	}
	if _, err := Launch2(ctx, img, vol, Req2{Op: "delete", Path: "a", Flags: "r"}, nil, nil); err != nil {
		t.Fatalf("recursive delete: %v", err)
	}
	if _, err := Launch2(ctx, img, vol, Req2{Op: "stat", Path: "a"}, nil, nil); itCode(err) != CodeNotFound {
		t.Fatalf("stat after delete: %v", err)
	}
	// the legacy list helper still sees what fsd2 wrote
	if entries, _, err := Launch(ctx, img, vol, "list", ""); err != nil || len(entries) != 0 {
		t.Fatalf("list: %v %v", entries, err)
	}
}

func TestIntegrationFsd2OwnershipUID999(t *testing.T) {
	img := itImage(t)
	vol := itVolume(t)
	itSeed(t, img, vol, "chown 999:999 /data && mkdir /data/appdir && chown 999:999 /data/appdir && echo old > /data/appdir/exist.txt && chown 1234:1234 /data/appdir/exist.txt")

	if _, err := itWrite(t, img, vol, "new.txt", "fresh", ""); err != nil {
		t.Fatalf("write into a uid-999 volume: %v", err)
	}
	if got := itBash(t, img, vol, "", "stat -c '%u:%g' /data/new.txt"); got != "999:999" {
		t.Fatalf("new file owner = %s, want 999:999", got)
	}
	// the app uid can read what the manager wrote
	if got := itBash(t, img, vol, "999:999", "cat /data/new.txt"); got != "fresh" {
		t.Fatalf("app uid read %q", got)
	}
	// an overwrite keeps the EXISTING owner (1234), not the parent's
	if _, err := itWrite(t, img, vol, "appdir/exist.txt", "replaced", "o"); err != nil {
		t.Fatal(err)
	}
	if got := itBash(t, img, vol, "", "stat -c '%u:%g' /data/appdir/exist.txt"); got != "1234:1234" {
		t.Fatalf("overwritten file owner = %s, want 1234:1234", got)
	}
	// mkdir -p hands every created level to the nearest existing ancestor's owner
	if _, err := Launch2(itCtx(t), img, vol, Req2{Op: "mkdir", Path: "appdir/x/y", Flags: "p"}, nil, nil); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{"appdir/x", "appdir/x/y"} {
		if got := itBash(t, img, vol, "", "stat -c '%u:%g' /data/"+d); got != "999:999" {
			t.Fatalf("%s owner = %s", d, got)
		}
	}
}

func TestIntegrationFsd2AdversarialSymlinks(t *testing.T) {
	img := itImage(t)
	vol := itVolume(t)
	itSeed(t, img, vol, "cd /data && ln -s /etc/passwd pw && ln -s ../ up && ln -s / rootlink && mkdir real && ln -s real inner && echo keep > real/k")
	ctx := itCtx(t)

	if st, err := Launch2(ctx, img, vol, Req2{Op: "stat", Path: "pw"}, nil, nil); err != nil || st.Stat.Type != "symlink" || st.Stat.LinkTarget != "/etc/passwd" {
		t.Fatalf("stat link: %+v %v", st, err)
	}
	if _, err := itRead(t, img, vol, "pw", 100); itCode(err) != CodeNotRegular {
		t.Fatalf("read through a final symlink: %v", err)
	}
	if _, err := itWrite(t, img, vol, "pw", "pwned", "o"); itCode(err) != CodeNotRegular {
		t.Fatalf("overwrite a final symlink: %v", err)
	}
	for _, link := range []string{"up", "rootlink", "inner"} {
		if _, err := itWrite(t, img, vol, link+"/etc/x", "x", ""); itCode(err) != CodeDenied {
			t.Fatalf("write via %s: %v", link, err)
		}
		if _, err := Launch2(ctx, img, vol, Req2{Op: "delete", Path: link + "/k", Flags: "r"}, nil, nil); itCode(err) != CodeDenied {
			t.Fatalf("delete via %s: %v", link, err)
		}
		if _, err := Launch2(ctx, img, vol, Req2{Op: "chmod", Path: link + "/k", Mode: "0777"}, nil, nil); itCode(err) != CodeDenied {
			t.Fatalf("chmod via %s: %v", link, err)
		}
	}
	// chmod on a final symlink never touches its target
	if _, err := Launch2(ctx, img, vol, Req2{Op: "chmod", Path: "pw", Mode: "0777"}, nil, nil); itCode(err) != CodeDenied {
		t.Fatalf("chmod final symlink: %v", err)
	}
	// removing a link removes the link only
	if _, err := Launch2(ctx, img, vol, Req2{Op: "delete", Path: "rootlink", Flags: "r"}, nil, nil); err != nil {
		t.Fatalf("delete rootlink: %v", err)
	}
	if got := itBash(t, img, vol, "", "test -e /etc/passwd && cat /data/real/k"); got != "keep" {
		t.Fatalf("collateral damage: %q", got)
	}
	// raw ".." never reaches the filesystem
	if _, err := Launch2(ctx, img, vol, Req2{Op: "stat", Path: "../etc"}, nil, nil); err == nil {
		t.Fatal("'..' accepted")
	}
}

func TestIntegrationFsd2FifoAndDevice(t *testing.T) {
	img := itImage(t)
	vol := itVolume(t)
	itSeed(t, img, vol, "cd /data && mkfifo pipe && mknod dev c 1 3 && echo x > regular")
	ctx := itCtx(t)
	for _, n := range []string{"pipe", "dev"} {
		st, err := Launch2(ctx, img, vol, Req2{Op: "stat", Path: n}, nil, nil)
		if err != nil || st.Stat.Type != "other" {
			t.Fatalf("stat %s: %+v %v", n, st, err)
		}
		done := make(chan error, 1)
		go func() { _, e := itRead(t, img, vol, n, 0); done <- e }()
		select {
		case e := <-done:
			if itCode(e) != CodeNotRegular {
				t.Fatalf("read %s: %v", n, e)
			}
		case <-time.After(60 * time.Second):
			t.Fatalf("read of %s hung", n)
		}
		if _, err := itWrite(t, img, vol, n, "x", "o"); itCode(err) != CodeNotRegular {
			t.Fatalf("overwrite %s: %v", n, err)
		}
	}
}

func TestIntegrationFsd2ENOSPC(t *testing.T) {
	img := itImage(t)
	name := "tugra_it_tmpfs_" + newContainerName()[len("tugra-fsd-"):]
	itDocker(t, "volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", "o=size=64k", name)
	t.Cleanup(func() { _ = exec.Command("docker", "volume", "rm", "-f", name).Run() })

	big := strings.Repeat("x", 256*1024)
	if _, err := itWrite(t, img, name, "big.bin", big, ""); itCode(err) != CodeNoSpace {
		t.Fatalf("write into a full volume: %v", err)
	}
	// the failed write left no partial file and no temp
	if got := itBash(t, img, name, "", "ls -A /data | wc -l"); strings.TrimSpace(got) != "0" {
		t.Fatalf("residue after ENOSPC: %s entries", got)
	}
}

func TestIntegrationFsd2ShaMismatchLeavesNothing(t *testing.T) {
	img := itImage(t)
	vol := itVolume(t)
	_, err := Launch2(itCtx(t), img, vol, Req2{Op: "write", Path: "f", Size: 5, Sha256: strings.Repeat("0", 64)}, strings.NewReader("hello"), nil)
	if itCode(err) != CodeIntegrity {
		t.Fatalf("err = %v", err)
	}
	if got := itBash(t, img, vol, "", "ls -A /data | wc -l"); strings.TrimSpace(got) != "0" {
		t.Fatalf("residue after a hash mismatch: %s entries", got)
	}
}

func TestIntegrationFsd2TimeoutReapsContainer(t *testing.T) {
	img := itImage(t)
	vol := itVolume(t)
	pr, pw := io.Pipe() // a body that never arrives: the helper blocks on stdin
	defer pw.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	_, err := Launch2(ctx, img, vol, Req2{Op: "write", Path: "slow", Size: 10, Sha256: strings.Repeat("0", 64)}, pr, nil)
	if !IsTimeout(err) {
		t.Fatalf("err = %v, want a timeout", err)
	}
	time.Sleep(2 * time.Second)
	if got := itDocker(t, "ps", "-aq", "--filter", "name=tugra-fsd-"); got != "" {
		t.Fatalf("helper container not reaped: %s", got)
	}
}

func TestIntegrationFsd2ReadClassCannotWrite(t *testing.T) {
	img := itImage(t)
	vol := itVolume(t)
	args, _, err := BuildHelperArgs2(img, vol, Req2{Op: "stat", Path: ""}, newContainerName())
	if err != nil {
		t.Fatal(err)
	}
	// Same hardening flags and read-only mount as the read profile, but run a shell that tries to write.
	cut := indexOfStr(args, "--entrypoint")
	probe := append(append([]string{}, args[1:cut]...), "--entrypoint", "bash", img, "-c", "touch /data/should-not-exist")
	out, rerr := exec.Command("docker", probe...).CombinedOutput()
	if rerr == nil || !strings.Contains(strings.ToLower(string(out)), "read-only") {
		t.Fatalf("a read-class mount accepted a write: %v %s", rerr, out)
	}
}

func indexOfStr(a []string, s string) int {
	for i, v := range a {
		if v == s {
			return i
		}
	}
	return -1
}
