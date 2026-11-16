//go:build dockerit

package migrate

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// L4 of the migration lab: the migrator's tar stream (GNU tar from the agent image, --sort=name --numeric-owner
// --format=gnu) is applied on the TARGET by safeWipeExtract with the pinned alpine busybox tar, never GNU tar. The unit
// suite stubs docker and dockerit_test.go extracts with the agent image's GNU tar, so until this test nothing proved that
// busybox keeps owners, modes, links, long names and special files. Skipped without docker or TUGRA_AGENT_IMAGE.

// volumeBackupScript is the hub source that owns the helper-image pin and the apply command.
const volumeBackupScript = "../../../apps/hub-api/src/volume-backups/volume-backup-script.ts"

var backupHelperPinRe = regexp.MustCompile(`(?s)export const BACKUP_HELPER_IMAGE =\s*"([^"]+)"`)

// applyExtractSnippet is the drain-mode extract safeWipeExtract runs for a streamed migration volume
// (vx-scripts.ts passes drain: true). The test reruns it verbatim; reading the hub source below fails the test when it
// drifts, so this never silently tests a command the target no longer runs.
const applyExtractSnippet = `cd /data && find . -mindepth 1 -delete; tar -xf -; r=$?; cat >/dev/null; exit $r`

// busyboxHelperImage returns the exact image safeWipeExtract runs on the target. It skips only when the hub source is
// not next to the agent (a standalone agent checkout); inside the monorepo a missing pin is a failure.
func busyboxHelperImage(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile(filepath.FromSlash(volumeBackupScript))
	if err != nil {
		t.Skipf("hub source not found (%v): cannot read the BACKUP_HELPER_IMAGE pin", err)
	}
	m := backupHelperPinRe.FindSubmatch(src)
	if m == nil {
		t.Fatal("BACKUP_HELPER_IMAGE pin not found in volume-backup-script.ts")
	}
	if !strings.HasPrefix(string(m[1]), "alpine:") {
		t.Fatalf("the helper image is %q: this test assumes the alpine busybox tar", m[1])
	}
	want := "tar ${tarFlags}-xf -; r=$?; cat >/dev/null; exit $r"
	if !strings.Contains(string(src), want) || !strings.Contains(string(src), "cd /data && find . -mindepth 1 -delete; tar ") {
		t.Fatal("safeWipeExtract's drain-mode extract changed: update applyExtractSnippet")
	}
	return string(m[1])
}

// busyboxSeed builds the L4 fixture with the busybox that created the volume: owners 999 and 70, modes 0600/0700/0750,
// a setuid file, hard and symbolic links (one dangling), a FIFO, a long and a unicode path, an empty dir, a sparse file.
func busyboxSeed(long string) string {
	return `set -e
cd /data
mkdir -p secret empty ` + long + ` 'ünï-dir' 'dir with spaces'
echo pg > secret/PG_VERSION && chmod 0600 secret/PG_VERSION && chown 999:999 secret/PG_VERSION
chmod 0700 secret && chown 999:999 secret
echo hl > a && ln a a.hardlink && ln -s a a.symlink && ln -s missing dangling
echo deep > ` + long + `/f.txt && echo u > 'ünï-dir/ü.txt' && echo s > 'dir with spaces/x y.txt'
LONGNAME=$(printf 'n%.0s' $(seq 1 200)); echo longname > "$LONGNAME"
echo exec > run.sh && chmod 4755 run.sh && chown 1000:1000 run.sh
mkfifo fifo
chown 70:70 empty && chmod 0750 empty
truncate -s 64M sparse.bin
printf 'HEAD' | dd of=sparse.bin bs=1 seek=0 conv=notrunc 2>/dev/null
printf 'MIDDLE' | dd of=sparse.bin bs=1 seek=33554432 conv=notrunc 2>/dev/null
printf 'TAIL' | dd of=sparse.bin bs=1 seek=67108860 conv=notrunc 2>/dev/null
dd if=/dev/urandom of=rand.bin bs=1024 count=3000 2>/dev/null
for f in a rand.bin sparse.bin run.sh "$LONGNAME" fifo; do touch -h -t 202301151030.45 "$f"; done
touch -t 202301151030.45 secret/PG_VERSION ` + long + `/f.txt 'ünï-dir/ü.txt' 'dir with spaces/x y.txt'`
}

// busyboxManifest prints one deterministic line per entry with every field a restore must keep. Directory sizes and
// mtimes are left out (the filesystem and the extractor set them); file mtimes are kept (busybox restores them).
const busyboxManifest = `cd /data && find . -mindepth 1 ! -type s | LC_ALL=C sort | while IFS= read -r p; do
  t=$(stat -c '%F' "$p")
  case "$t" in
    "regular file"|"regular empty file")
      m=$(stat -c '%a' "$p"); [ ${#m} -eq 4 ] && m=${m#?} # the setuid digit is recorded separately (see the test)
      echo "$p|$t|$(stat -c '%u:%g' "$p")|$m|$(stat -c '%s|%h|%Y' "$p")|$(sha256sum < "$p" | cut -d' ' -f1)" ;;
    "symbolic link") echo "$p|$t|$(stat -c '%u:%g' "$p")|$(readlink "$p")" ;;
    *) echo "$p|$t|$(stat -c '%u:%g|%a' "$p")" ;;
  esac
done`

func busyboxLines(t *testing.T, docker, image, vol string) []string {
	t.Helper()
	out := dsh(t, docker, "run", "--rm", "-v", vol+":/data:ro", image, "sh", "-c", busyboxManifest)
	return strings.Split(out, "\n")
}

func TestDockerITBusyboxExtractKeepsTheMigratorStream(t *testing.T) {
	docker, agentImage := dockerHelper(t)
	busybox := busyboxHelperImage(t)
	env := dockerBaseEnv(os.LookupEnv)
	src, dst := "tugra_vxbb_src_"+shortRun(newRunID()), "tugra_vxbb_dst_"+shortRun(newRunID())
	for _, v := range []string{src, dst} {
		dsh(t, docker, "volume", "create", v)
		defer exec.Command(docker, "volume", "rm", "-f", v).Run()
	}
	long := strings.Repeat("d", 60) + "/" + strings.Repeat("e", 60) + "/" + strings.Repeat("f", 60)
	dsh(t, docker, "run", "--rm", "-v", src+":/data", busybox, "sh", "-c", busyboxSeed(long))
	// the destination holds leftovers the apply must wipe before it extracts (find -mindepth 1 -delete)
	dsh(t, docker, "run", "--rm", "-v", dst+":/data", busybox, "sh", "-c", "mkdir -p /data/old/deep && echo junk > /data/old/deep/x && echo j > /data/.hidden")

	// the source side: the REAL hardened argv of the migrator, streamed to a file (the sparse file makes it 64 MiB)
	archive := filepath.Join(t.TempDir(), "vx.tar")
	argv := buildTarArgv(docker, agentImage, src, "tugra-vxbb-"+shortRun(newRunID()), nil)
	out, wait, err := startTarFn(context.Background(), argv, env)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(f, out); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := wait(); err != nil {
		t.Fatalf("tar helper: %v", err)
	}

	run := func(args ...string) (string, error) {
		in, err := os.Open(archive)
		if err != nil {
			t.Fatal(err)
		}
		defer in.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, docker, args...)
		cmd.Stdin = in
		b, err := cmd.CombinedOutput()
		return string(b), err
	}

	// 1. the validation step of safeWipeExtract: busybox lists the archive, no entry is absolute or `..`
	list, err := run("run", "--rm", "-i", busybox, "tar", "-tf", "-")
	if err != nil {
		t.Fatalf("busybox rejects the migrator archive (apply would exit 72): %v\n%s", err, list)
	}
	for _, want := range []string{strings.Repeat("e", 60), "ünï-dir/ü.txt", "a.hardlink", "fifo", strings.Repeat("n", 200)} {
		if !strings.Contains(list, want) {
			t.Errorf("busybox tar -t does not list %.40q", want)
		}
	}
	if regexp.MustCompile(`(?m)^/|(^|/)[.][.](/|$)`).MatchString(list) {
		t.Error("the archive lists an absolute or .. entry (safeWipeExtract refuses those)")
	}

	// 2. the extract step, byte for byte what the target runs, with no --no-same-owner
	if b, err := run("run", "--rm", "-i", "-v", dst+":/data", busybox, "sh", "-c", applyExtractSnippet); err != nil {
		t.Fatalf("busybox extract failed (apply would exit 71 and roll back): %v\n%s", err, b)
	}

	// 3. field-level comparison: owner, mode, type, size, hardlink count, mtime (files), symlink target, content hash
	have, want := busyboxLines(t, docker, busybox, dst), busyboxLines(t, docker, busybox, src)
	if len(want) < 15 {
		t.Fatalf("the fixture manifest is suspiciously small (%d lines): %q", len(want), want)
	}
	if strings.Join(have, "\n") != strings.Join(want, "\n") {
		t.Errorf("destination differs from the source after a busybox extract:\n%s", lineDiff(want, have))
	}
	for _, junk := range []string{"./old", "./.hidden"} {
		for _, l := range have {
			if strings.HasPrefix(l, junk) {
				t.Errorf("the wipe left %s behind", junk)
			}
		}
	}

	// 4. the spot checks the runbook lists by name, so a regression names the entry
	stat := func(p string) string {
		return dsh(t, docker, "run", "--rm", "-v", dst+":/data:ro", busybox, "stat", "-c", "%u:%g %a", "/data/"+p)
	}
	for p, w := range map[string]string{"secret/PG_VERSION": "999:999 600", "secret": "999:999 700", "empty": "70:70 750"} {
		if got := stat(p); got != w {
			t.Errorf("%s: %s want %s", p, got, w)
		}
	}
	got := dsh(t, docker, "run", "--rm", "-v", dst+":/data:ro", busybox, "sh", "-c",
		`[ /data/a -ef /data/a.hardlink ] && echo HARDLINK; [ "$(readlink /data/a.symlink)" = a ] && echo SYMLINK; [ -L /data/dangling ] && echo DANGLING; test -p /data/fifo && echo FIFO; cat '/data/ünï-dir/ü.txt'; cat /data/`+long+`/f.txt`)
	for _, w := range []string{"HARDLINK", "SYMLINK", "DANGLING", "FIFO", "u", "deep"} {
		if !strings.Contains(got, w) {
			t.Errorf("after the busybox extract %q is missing: %q", w, got)
		}
	}

	// 5. documented limits, recorded not failed: the setuid bit and what a sparse file costs on the target
	t.Logf("setuid file on the target: %s", dsh(t, docker, "run", "--rm", "-v", dst+":/data:ro", busybox, "stat", "-c", "%u:%g %a", "/data/run.sh"))
	du := func(vol string) string {
		return dsh(t, docker, "run", "--rm", "-v", vol+":/data:ro", busybox, "sh", "-c", "du -k /data/sparse.bin | cut -f1; stat -c %s /data/sparse.bin")
	}
	t.Logf("sparse.bin KiB-on-disk / apparent bytes: source %q, target %q (GNU tar without -S stores holes as zeros; the content is identical, the holes are not)",
		strings.ReplaceAll(du(src), "\n", " / "), strings.ReplaceAll(du(dst), "\n", " / "))
}

// busybox must also accept the archive when `head -c <rawBytes>` closes the pipe right after the end-of-archive marker:
// the drain variant keeps tar's own exit code. This pins that behaviour with an extra trailing block, as gunzip | head -c does.
func TestDockerITBusyboxDrainKeepsTarExitCode(t *testing.T) {
	docker, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("docker not available")
	}
	busybox := busyboxHelperImage(t)
	vol := "tugra_vxbb_drain_" + shortRun(newRunID())
	dsh(t, docker, "volume", "create", vol)
	defer exec.Command(docker, "volume", "rm", "-f", vol).Run()
	mk := exec.Command(docker, "run", "--rm", "-i", busybox, "sh", "-c", "mkdir /t && echo hi > /t/f && tar -cf - -C /t .")
	var tarball bytes.Buffer
	mk.Stdout = &tarball
	if err := mk.Run(); err != nil {
		t.Fatal(err)
	}
	// a valid archive followed by trailing padding the extractor never reads
	padded := append(tarball.Bytes(), make([]byte, 1<<20)...)
	ext := exec.Command(docker, "run", "--rm", "-i", "-v", vol+":/data", busybox, "sh", "-c", applyExtractSnippet)
	ext.Stdin = bytes.NewReader(padded)
	if b, err := ext.CombinedOutput(); err != nil {
		t.Fatalf("drain extract of a valid archive: %v\n%s", err, b)
	}
	if got := dsh(t, docker, "run", "--rm", "-v", vol+":/data:ro", busybox, "cat", "/data/f"); got != "hi" {
		t.Errorf("content %q", got)
	}
	// and a truncated archive must FAIL (never silently apply half a volume)
	bad := exec.Command(docker, "run", "--rm", "-i", "-v", vol+":/data", busybox, "sh", "-c", applyExtractSnippet)
	bad.Stdin = bytes.NewReader(tarball.Bytes()[:len(tarball.Bytes())/2+7])
	if b, err := bad.CombinedOutput(); err == nil {
		t.Fatalf("a truncated archive extracted cleanly: %s", b)
	}
}

func lineDiff(want, have []string) string {
	set := func(ls []string) map[string]bool {
		m := map[string]bool{}
		for _, l := range ls {
			m[l] = true
		}
		return m
	}
	w, h := set(want), set(have)
	var d []string
	for _, l := range want {
		if !h[l] {
			d = append(d, "- "+l)
		}
	}
	for _, l := range have {
		if !w[l] {
			d = append(d, "+ "+l)
		}
	}
	sort.Strings(d)
	return strings.Join(d, "\n")
}
