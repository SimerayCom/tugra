// Package selfupdate applies a hub-signed, digest-pinned agent update: pull the new image by its
// manifest digest (Docker enforces it), then recreate this agent's own container onto it. The agent
// can't recreate itself inline (removing its own container kills the process mid-command), so it hands
// off to a DETACHED one-shot helper container that outlives it — the same "a separate container does
// the recreate" pattern the hub's tugra-updater sidecar uses.
package selfupdate

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Signed values are treated as untrusted (defense-in-depth): reject anything outside a conservative
// charset before it reaches a docker command. Combined with argv-form exec (never `sh -c`), injection
// via image/sha256 is impossible by construction.
var (
	imageRe  = regexp.MustCompile(`^[A-Za-z0-9._:/@-]+$`)
	sha256Re = regexp.MustCompile(`^[a-f0-9]{64}$`)
	nameRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)
)

// ValidateImageRef rejects an image ref with unexpected characters (or an implausible length).
func ValidateImageRef(ref string) error {
	if ref == "" || len(ref) > 512 || !imageRe.MatchString(ref) {
		return fmt.Errorf("invalid image ref")
	}
	return nil
}

// ValidateSha256 requires exactly 64 lowercase hex chars (a bare image-manifest digest).
func ValidateSha256(hex string) error {
	if !sha256Re.MatchString(hex) {
		return fmt.Errorf("invalid sha256")
	}
	return nil
}

// ShouldApply decides whether to apply target over self. Fail-OPEN: an unparseable version applies (the
// hub already gated never-downgrade; a re-pull of the same digest is harmless). equal → noop; self newer
// → refuse (downgrade).
func ShouldApply(self, target string) (apply, noop bool) {
	if self == target {
		return false, true // exact same version string → nothing to do
	}
	sv, sok := parseVersion(self)
	tv, tok := parseVersion(target)
	if !sok || !tok {
		return true, false // can't compare → apply (fail-open)
	}
	if cmpVer(sv, tv) == 1 {
		return false, false // self's core (major.minor.patch) strictly newer → refuse downgrade
	}
	// self core older (real upgrade) OR cores equal but strings differ (e.g. 0.3.0-rc.2 → 0.3.0, a genuine
	// prerelease→GA upgrade) → apply. Only an EXACT string match is a noop; the hub already gated
	// never-downgrade, so applying an equal-core/different-string target is safe (re-pull of same digest).
	return true, false
}

// parseVersion extracts MAJOR.MINOR.PATCH, ignoring a leading "v" and any -prerelease/+build suffix.
func parseVersion(v string) ([3]int, bool) {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}

func cmpVer(a, b [3]int) int {
	for i := 0; i < 3; i++ {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	return 0
}

// RecreateSpec is everything the detached helper needs to recreate this agent onto NewImageRef.
type RecreateSpec struct {
	SelfName    string // this agent's container name
	DataVolume  string // named volume mounted at /root/.tugra (holds the agent's identity)
	HubURL      string // TUGRA_HUB for the new container (the reconnect uses the volume identity, no token)
	NewImageRef string // image@sha256:digest to run
	OldImageRef string // fallback if the new image fails to start (host must never be left agentless)
}

// BuildRecreateInvocation returns the exact `docker run` argv for the detached helper and the fixed inner
// script it runs. Pure + deterministic (byte-tested). All dynamic values reach the helper as `-e KEY=VALUE`
// argv entries and are referenced QUOTED inside the fixed script — the agent never builds a shell string,
// so nothing here can be injected. The helper is the new agent image itself (it ships the docker CLI + sh).
func BuildRecreateInvocation(s RecreateSpec) (argv []string, innerScript string, err error) {
	if !nameRe.MatchString(s.SelfName) || !nameRe.MatchString(s.DataVolume) {
		return nil, "", fmt.Errorf("invalid self name or data volume")
	}
	if s.NewImageRef == "" || s.OldImageRef == "" || s.HubURL == "" {
		return nil, "", fmt.Errorf("missing recreate inputs")
	}
	// Note: TUGRA_TOKEN is deliberately omitted — the enroll token is single-use; the recreated agent
	// re-auths using the identity persisted in the DataVolume. On ANY new-image failure — a container that
	// won't create/start, OR one that starts then crashes (a bad build) — fall back to the OLD image so the
	// host is never left without a running agent. `docker run -d` exiting 0 only means "started", so we
	// health-gate: the new container must still be Running with 0 restarts a few seconds later. Each run is
	// preceded by `docker rm -f "$SELF"` so a leftover container never blocks the next run on a name conflict.
	runNew := `docker run -d --name "$SELF" --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA_VOL":/root/.tugra -v /etc/tugra:/etc/tugra -e TUGRA_HUB="$HUB" -e TUGRA_AGENT_IMAGE="$NEW_IMAGE" "$NEW_IMAGE"`
	runOld := `docker run -d --name "$SELF" --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock -v "$DATA_VOL":/root/.tugra -v /etc/tugra:/etc/tugra -e TUGRA_HUB="$HUB" -e TUGRA_AGENT_IMAGE="$OLD_IMAGE" "$OLD_IMAGE"`
	innerScript = strings.Join([]string{
		"set -e",
		"sleep 3",
		`docker rm -f "$SELF" >/dev/null 2>&1 || true`,
		"if " + runNew + "; then",
		"  sleep 5",
		`  if [ "$(docker inspect -f '{{.State.Running}}' "$SELF" 2>/dev/null)" = "true" ] && [ "$(docker inspect -f '{{.RestartCount}}' "$SELF" 2>/dev/null)" = "0" ]; then`,
		"    exit 0",
		"  fi",
		"fi",
		`docker rm -f "$SELF" >/dev/null 2>&1 || true`,
		runOld,
	}, "\n")
	argv = []string{
		"docker", "run", "-d", "--rm", "--entrypoint", "/bin/sh",
		"-v", "/var/run/docker.sock:/var/run/docker.sock",
		"-e", "SELF=" + s.SelfName,
		"-e", "DATA_VOL=" + s.DataVolume,
		"-e", "HUB=" + s.HubURL,
		"-e", "NEW_IMAGE=" + s.NewImageRef,
		"-e", "OLD_IMAGE=" + s.OldImageRef,
		s.NewImageRef, "-c", innerScript,
	}
	return argv, innerScript, nil
}

// Resolve inspects this agent's own container to discover its name, current image, and data volume, so the
// recreate reuses them (handles custom --name / --volume installs). Falls back to the install defaults.
func Resolve(ctx context.Context, hubURL string) RecreateSpec {
	spec := RecreateSpec{SelfName: "tugra-agent", DataVolume: "tugra-agent-data", HubURL: hubURL}
	host, _ := os.Hostname() // = the container's short id by default
	if host == "" {
		return spec
	}
	if name := dockerInspect(ctx, host, "{{.Name}}"); name != "" {
		spec.SelfName = strings.TrimPrefix(name, "/")
	}
	spec.OldImageRef = dockerInspect(ctx, host, "{{.Config.Image}}")
	if vol := dockerInspect(ctx, host, `{{range .Mounts}}{{if eq .Destination "/root/.tugra"}}{{.Name}}{{end}}{{end}}`); vol != "" {
		spec.DataVolume = vol
	}
	return spec
}

// Apply pulls the digest-pinned image (Docker verifies the digest) while the agent is still alive, then
// launches the detached helper that recreates it. `report` is called with the pre-handoff outcome; success
// is otherwise observed by the hub when the recreated agent reconnects with the new version.
func Apply(ctx context.Context, hubURL, image, sha256 string, report func(ok bool, phase, errMsg string)) {
	if err := ValidateImageRef(image); err != nil {
		report(false, "validate", err.Error())
		return
	}
	if err := ValidateSha256(sha256); err != nil {
		report(false, "validate", err.Error())
		return
	}
	pinned := image + "@sha256:" + sha256
	if err := dockerPull(ctx, pinned); err != nil {
		report(false, "pull", err.Error()) // agent stays on the old version — pull is before any handoff
		return
	}
	spec := Resolve(ctx, hubURL)
	if spec.OldImageRef == "" {
		report(false, "resolve", "cannot determine current image — aborting to avoid an agentless host")
		return
	}
	spec.NewImageRef = pinned
	argv, _, err := BuildRecreateInvocation(spec)
	if err != nil {
		report(false, "helper", err.Error())
		return
	}
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(c, argv[0], argv[1:]...).CombinedOutput(); err != nil {
		report(false, "helper", fmt.Sprintf("%v: %s", err, string(out)))
		return
	}
	// Helper launched; it will `docker rm -f` this agent shortly and start the new one.
	report(true, "applying", "")
}

func dockerPull(ctx context.Context, ref string) error {
	c, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	if out, err := exec.CommandContext(c, "docker", "pull", ref).CombinedOutput(); err != nil {
		return fmt.Errorf("docker pull: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func dockerInspect(ctx context.Context, id, format string) string {
	c, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(c, "docker", "inspect", "-f", format, id).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
