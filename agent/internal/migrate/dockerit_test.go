//go:build dockerit

package migrate

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Real-docker gate (CI job `agent-docker-it`, skipped without docker): the source-side tar helper, run with the REAL
// hardened argv, reads a volume holding root-unreadable files with DAC_READ_SEARCH as the only added capability and
// produces an archive that a second helper extracts back with owner, group, mode, links and special entries intact.
func dockerHelper(t *testing.T) (docker, image string) {
	t.Helper()
	image = os.Getenv("TUGRA_AGENT_IMAGE")
	if image == "" {
		t.Skip("TUGRA_AGENT_IMAGE not set")
	}
	p, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("docker not available")
	}
	return p, image
}

func dsh(t *testing.T, docker string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, docker, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestDockerITTarHelperReadsAndRestoresOwnershipAndModes(t *testing.T) {
	docker, image := dockerHelper(t)
	env := dockerBaseEnv(os.LookupEnv)
	src, dst := "tugra_vxit_src_"+shortRun(newRunID()), "tugra_vxit_dst_"+shortRun(newRunID())
	for _, v := range []string{src, dst} {
		dsh(t, docker, "volume", "create", v)
		defer exec.Command(docker, "volume", "rm", "-f", v).Run()
	}
	long := strings.Repeat("d", 60) + "/" + strings.Repeat("e", 60) + "/" + strings.Repeat("f", 60)
	seed := `set -e
cd /data
mkdir -p secret empty ` + long + ` 'ünï-dir'
echo pg > secret/PG_VERSION && chmod 0600 secret/PG_VERSION && chown 999:999 secret/PG_VERSION
chmod 0700 secret && chown 999:999 secret
echo hl > file && ln file hardlink && ln -s file symlink
echo deep > ` + long + `/f.txt && echo u > 'ünï-dir/ü.txt'
mkfifo fifo
chown 70:70 empty && chmod 0750 empty`
	dsh(t, docker, "run", "--rm", "-v", src+":/data", "--entrypoint", "sh", image, "-c", seed)

	// stream through the REAL hardened argv
	argv := buildTarArgv(docker, image, src, "tugra-vxit-"+shortRun(newRunID()), nil)
	out, wait, err := startTarFn(context.Background(), argv, env)
	if err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	if _, err := io.Copy(&archive, out); err != nil {
		t.Fatal(err)
	}
	if err := wait(); err != nil {
		t.Fatalf("the helper needs only DAC_READ_SEARCH to read 0600/0700 files owned by another uid: %v", err)
	}
	// an apply-style extract in a different helper (busybox/GNU as shipped): ownership is preserved
	extract := exec.Command(docker, "run", "--rm", "-i", "-v", dst+":/data", "--entrypoint", "tar", image, "-xf", "-", "-C", "/data")
	extract.Stdin = bytes.NewReader(archive.Bytes())
	if b, err := extract.CombinedOutput(); err != nil {
		t.Fatalf("extract: %v\n%s", err, b)
	}
	stat := func(p string) string {
		return dsh(t, docker, "run", "--rm", "-v", dst+":/data:ro", "--entrypoint", "stat", image, "-c", "%u:%g %a", "/data/"+p)
	}
	for p, want := range map[string]string{"secret/PG_VERSION": "999:999 600", "secret": "999:999 700", "empty": "70:70 750"} {
		if got := stat(p); got != want {
			t.Errorf("%s: %s want %s", p, got, want)
		}
	}
	if got := dsh(t, docker, "run", "--rm", "-v", dst+":/data:ro", "--entrypoint", "sh", image, "-c", "[ /data/file -ef /data/hardlink ] && readlink /data/symlink && test -p /data/fifo && cat '/data/ünï-dir/ü.txt'"); !strings.Contains(got, "file") || !strings.Contains(got, "u") {
		t.Errorf("links/fifo/unicode: %q", got)
	}
	// the archive is deterministic: a second read gives the same bytes (resume compares raw slice hashes)
	out2, wait2, _ := startTarFn(context.Background(), buildTarArgv(docker, image, src, "tugra-vxit-"+shortRun(newRunID()), nil), env)
	var again bytes.Buffer
	_, _ = io.Copy(&again, out2)
	_ = wait2()
	if !bytes.Equal(archive.Bytes(), again.Bytes()) {
		t.Error("--sort=name must make the tar stream deterministic")
	}
	// inventory with the same helper agrees with what was seeded
	vs := &volSource{ContainerID: appCtrID, Name: "x", MountType: "volume", VolumeName: src, Image: "x", Destination: "/data"}
	inv, err := InventoryVolume(context.Background(), docker, env, image, vs, nil)
	if err != nil || inv.Entries < 8 || inv.Fifos != 1 || inv.Devices != 0 {
		t.Errorf("inventory: %+v %v", inv, err)
	}
}
