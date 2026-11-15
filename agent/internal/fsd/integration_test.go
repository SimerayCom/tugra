//go:build dockerit

package fsd

import (
	"context"
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
