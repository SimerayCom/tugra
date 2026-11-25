package coolify

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// Output is what one docker command produced. Both streams are capped by the executor.
type Output struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
	TimedOut bool
}

// Exec runs one argv (no shell) with optional stdin and returns its capped output. A non-zero exit is not an error: it is in Output. name is
// the helper container's name, so a timeout can remove the daemon-owned container (killing the docker CLI alone would leave it running).
type Exec func(ctx context.Context, argv []string, stdin []byte, name string) (Output, error)

const (
	maxStdout = 256 * 1024
	maxStderr = 16 * 1024
	// MaxScriptBytes bounds the install script the hub may send.
	MaxScriptBytes = 256 * 1024
)

// Env is what the agent itself knows and the hub never supplies: its own image, and the hub it is connected to.
type Env struct {
	Image  string
	HubURL string
	HubPin string
}

// Request is a verified coolify_ssh_req, reduced to what the runner needs.
type Request struct {
	Op         string
	UUID       string
	UseSudo    bool
	ExpectedFp string
	Script     string // install only
	Payload    string // install: the enroll token; uninstall: the container id
}

// Runner runs one probe, install or uninstall. It holds no state; the caller bounds concurrency and replays.
type Runner struct {
	Env   Env
	Exec  Exec
	NewID func() string
	Log   func(format string, args ...any)
}

// NewRunner returns a Runner that talks to the real docker.
func NewRunner(env Env) *Runner {
	return &Runner{Env: env, Exec: ExecDocker, NewID: randomHex, Log: func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }}
}

func randomHex() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (r *Runner) name() string { return "tugra-cssh-" + r.NewID() }

func (r *Runner) logf(f string, a ...any) {
	if r.Log != nil {
		r.Log(f, a...)
	}
}

// Run executes req and returns the wire result. It never returns an error: every failure is a fixed code. Secrets (the token, the container
// id of another host) are scrubbed from anything logged, and nothing the target printed is sent to the hub except the parsed probe facts.
func (r *Runner) Run(ctx context.Context, reqID string, req Request) protocol.CoolifySSHResult {
	start := time.Now()
	res := protocol.CoolifySSHResult{Type: "coolify_ssh_result", ReqID: reqID}
	finish := func() protocol.CoolifySSHResult {
		res.DurationMs = time.Since(start).Milliseconds()
		return res
	}
	fa := func(err error, fallback string) protocol.CoolifySSHResult {
		res.OK, res.Code = false, CodeOf(err, fallback)
		r.logf("coolify ssh %s: %s (%s)", req.Op, res.Code, scrub(errText(err), req.Payload))
		return finish()
	}

	if ctx.Err() != nil {
		return fa(fail("cancelled", "cancelled before start"), "cancelled")
	}
	t, keyDir, err := r.resolve(ctx, req.UUID)
	if err != nil {
		return fa(err, "bad_target")
	}
	// The key file must be readable by the helper before anything else happens.
	if err := r.keyReadable(ctx, keyDir, t); err != nil {
		return fa(err, "no_key_file")
	}
	scan, err := r.scan(ctx, t)
	if err != nil {
		return fa(err, "unreachable")
	}
	fp, pinned, err := CheckHostKey(scan, t.PinnedHostKey, req.ExpectedFp)
	if err != nil {
		return fa(err, "unreachable")
	}
	hostKey := fp

	switch req.Op {
	case "probe":
		script, _ := ScriptFor("probe")
		out, err := r.ssh(ctx, keyDir, t, RemoteCommand(false), Prefix([2]string{"TUGRA_HUB", r.hubForTarget()})+script)
		if err != nil {
			return fa(err, "unreachable")
		}
		if out.ExitCode != 0 && !strings.Contains(string(out.Stdout), probeLinePrefix) {
			res.OK, res.Code = false, ClassifySSHFailure(string(out.Stderr), out.ExitCode, out.TimedOut)
			return finish()
		}
		pr := ParseProbe(string(out.Stdout))
		res.Probe = pr.Facts()
		res.Probe.SSHHostKeyFp = hostKey
		res.Probe.HostKeyPinned = &pinned
		res.OK, res.Code = pr.Verdict()
		return finish()

	case "install":
		if err := ValidateInstallInputs(req.Script, req.Payload); err != nil {
			return fa(err, "installer_failed")
		}
		if !ValidImage(r.Env.Image) || r.Env.HubURL == "" {
			return fa(fail("installer_failed", "agent is not configured to install"), "installer_failed")
		}
		prefix := Prefix(
			[2]string{"TUGRA_HUB", r.Env.HubURL},
			[2]string{"TUGRA_HUB_PIN", r.Env.HubPin},
			[2]string{"TUGRA_TOKEN", req.Payload},
			[2]string{"TUGRA_SKIP_DOCKER_INSTALL", "1"},
		)
		out, err := r.ssh(ctx, keyDir, t, RemoteCommand(req.UseSudo, "--image", r.Env.Image), prefix+req.Script)
		if err != nil {
			return fa(err, "unreachable")
		}
		so := string(out.Stdout)
		if out.ExitCode == 0 && strings.Contains(so, "TUGRA_INSTALL_OK") {
			res.OK, res.Code = true, "ok_installed"
			res.ContainerID = installedContainerID(so)
			return finish()
		}
		res.OK = false
		res.Code = ClassifySSHFailure(scrub(string(out.Stderr)+"\n"+so, req.Payload), out.ExitCode, out.TimedOut)
		r.logf("coolify ssh install: %s", res.Code)
		return finish()

	case "uninstall":
		if len(req.Payload) != 64 || !isHex(req.Payload) {
			return fa(fail("bad_target", "invalid container id"), "bad_target")
		}
		script, _ := ScriptFor("uninstall")
		prefix := Prefix([2]string{"TUGRA_HUB", r.Env.HubURL}, [2]string{"TUGRA_CID", req.Payload})
		out, err := r.ssh(ctx, keyDir, t, RemoteCommand(req.UseSudo), prefix+script)
		if err != nil {
			return fa(err, "unreachable")
		}
		switch uninstallOutcome(string(out.Stdout)) {
		case "ok", "gone":
			res.OK, res.Code = true, "ok_installed"
		case "refused_id", "refused_hub", "refused_docker":
			res.OK, res.Code = false, "bad_target"
		default:
			res.OK, res.Code = false, ClassifySSHFailure(string(out.Stderr), out.ExitCode, out.TimedOut)
		}
		return finish()
	}
	return fa(fail("bad_target", "unknown op"), "bad_target")
}

var tokenRe = regexp.MustCompile(`^tugra_en_[A-Za-z0-9_-]{16,128}$`)

// ValidateInstallInputs checks what an install is about to send: the token has the enroll-token shape, and the hub-rendered script is a
// bounded text that ends by reporting success and does not carry the token (the token travels in the prefix only).
func ValidateInstallInputs(script, token string) error {
	if !tokenRe.MatchString(token) {
		return fail("installer_failed", "invalid enroll token")
	}
	if script == "" || len(script) > MaxScriptBytes || strings.ContainsRune(script, 0) {
		return fail("installer_failed", "invalid install script")
	}
	if !strings.Contains(script, "TUGRA_INSTALL_OK") || strings.Contains(script, token) {
		return fail("installer_failed", "invalid install script")
	}
	return nil
}

// hubForTarget is the hub address the probe tests reachability of: the agent's own endpoint, never one the hub names in the frame.
func (r *Runner) hubForTarget() string { return r.Env.HubURL }

func (r *Runner) resolve(ctx context.Context, uuid string) (Target, string, error) {
	sql, err := TargetSQL(uuid)
	if err != nil {
		return Target{}, "", err
	}
	out, err := r.Exec(ctx, ResolveArgs(), []byte(sql), "")
	if err != nil {
		return Target{}, "", fail("bad_target", "database read failed")
	}
	if out.ExitCode != 0 {
		return Target{}, "", fail("bad_target", "Coolify's database is not readable")
	}
	t, err := ParseTarget(uuid, string(out.Stdout))
	if err != nil {
		return Target{}, "", err
	}
	mo, err := r.Exec(ctx, InspectCoolifyArgs(), nil, "")
	if err != nil || mo.ExitCode != 0 {
		return Target{}, "", fail("no_key_file", "Coolify container not found")
	}
	keyDir, err := KeyDirFromMounts(string(mo.Stdout))
	if err != nil {
		return Target{}, "", err
	}
	return t, keyDir, nil
}

func (r *Runner) keyReadable(ctx context.Context, keyDir string, t Target) error {
	name := r.name()
	argv, err := KeyCheckArgs(r.Env.Image, name, keyDir, t)
	if err != nil {
		return err
	}
	out, err := r.Exec(ctx, argv, nil, name)
	if err != nil || out.ExitCode != 0 {
		return fail("no_key_file", "key file not readable")
	}
	return nil
}

func (r *Runner) scan(ctx context.Context, t Target) (string, error) {
	name := r.name()
	argv, err := ScanArgs(r.Env.Image, name, t)
	if err != nil {
		return "", err
	}
	out, err := r.Exec(ctx, argv, nil, name)
	if err != nil {
		return "", fail("unreachable", "scan failed")
	}
	if out.TimedOut {
		return "", fail("timeout", "scan timed out")
	}
	if strings.TrimSpace(string(out.Stdout)) == "" {
		return "", fail("unreachable", "no host key offered")
	}
	return string(out.Stdout), nil
}

func (r *Runner) ssh(ctx context.Context, keyDir string, t Target, remote []string, stdin string) (Output, error) {
	name := r.name()
	argv, err := SSHArgs(r.Env.Image, name, keyDir, t, remote)
	if err != nil {
		return Output{}, err
	}
	out, err := r.Exec(ctx, argv, []byte(stdin), name)
	if err != nil {
		return Output{}, fail("unreachable", "ssh helper failed to start")
	}
	if out.TimedOut {
		return Output{}, fail("timeout", "ssh timed out")
	}
	if ctx.Err() != nil {
		return Output{}, fail("cancelled", "cancelled")
	}
	return out, nil
}

func installedContainerID(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "TUGRA_INSTALL_CID ") {
			id := strings.TrimSpace(strings.TrimPrefix(line, "TUGRA_INSTALL_CID "))
			if len(id) == 64 && isHex(id) {
				return id
			}
		}
	}
	return ""
}

func uninstallOutcome(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "TUGRA_UNINSTALL ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "TUGRA_UNINSTALL "))
		}
	}
	return ""
}

func errText(err error) string {
	var se *SSHError
	if errors.As(err, &se) {
		return se.Msg
	}
	if err != nil {
		return "error"
	}
	return ""
}

// scrub removes every secret from text that is about to be logged. It is a backstop: nothing of this lane logs target output.
func scrub(text string, secrets ...string) string {
	for _, s := range secrets {
		if len(s) >= 8 {
			text = strings.ReplaceAll(text, s, "[redacted]")
		}
	}
	if len(text) > 300 {
		text = text[:300]
	}
	return text
}

// ExecDocker is the production Exec: os/exec without a shell, stdin from the caller, both output streams capped, and the named helper
// container force-removed if the context ends first.
func ExecDocker(ctx context.Context, argv []string, stdin []byte, name string) (Output, error) {
	if len(argv) == 0 || argv[0] != "docker" {
		return Output{}, errors.New("only docker may be run")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	so, se := &capBuffer{max: maxStdout}, &capBuffer{max: maxStderr}
	cmd.Stdout, cmd.Stderr = so, se
	err := cmd.Run()
	out := Output{Stdout: so.buf.Bytes(), Stderr: se.buf.Bytes()}
	if ctx.Err() != nil {
		out.TimedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		if name != "" && helperNameRe.MatchString(name) {
			rmCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = exec.CommandContext(rmCtx, "docker", "rm", "-f", name).Run()
		}
		return out, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		out.ExitCode = ee.ExitCode()
		return out, nil
	}
	if err != nil {
		return out, err
	}
	return out, nil
}

type capBuffer struct {
	buf bytes.Buffer
	max int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	if room := c.max - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}
