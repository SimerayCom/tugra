package coolify

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// These tests RUN the embedded scripts under a real sh with a stub `docker` first on PATH (and stubs for the few other tools), so the shell
// logic that decides "ours / foreign / stopped / none" and "which container may be removed" is exercised, not only parsed.

func stubDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func runScript(t *testing.T, script, dir string, env ...string) string {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no sh")
	}
	// The scripts pin PATH to the system directories (a hostile PATH must not matter); the test puts its stubs in front of that value.
	const pin = "export PATH=/usr/local/sbin:"
	if !strings.Contains(script, pin) {
		t.Fatal("the script no longer pins PATH")
	}
	script = strings.Replace(script, pin, "export PATH="+dir+":/usr/local/sbin:", 1)
	cmd := exec.Command(sh, "-s")
	cmd.Stdin = strings.NewReader(script)
	// stubs first, then the real tools the scripts use (id, uname, df, awk, grep, tr, cut, head, printf)
	cmd.Env = append([]string{"PATH=" + dir + ":/usr/bin:/bin", "HOME=" + dir}, env...)
	out, _ := cmd.CombinedOutput()
	return string(out)
}

const dockerPS = `
case "$1" in
  info) exit 0 ;;
  inspect)
    case "$*" in
      *"{{.State.Running}}"*) echo "$STUB_RUNNING" ;;
      *"{{.Id}}"*) echo "$STUB_ID" ;;
      *"Config.Env"*) printf 'PATH=/bin\nTUGRA_HUB=%s\nTUGRA_TOKEN=secretvalue\n' "$STUB_HUB" ;;
      *) [ "$STUB_PRESENT" = "1" ] && exit 0 || exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
`

func probeWith(t *testing.T, env ...string) ProbeResult {
	t.Helper()
	dir := stubDir(t, map[string]string{"docker": dockerPS, "curl": "exit 0\n"})
	script, _ := ScriptFor("probe")
	out := runScript(t, "export TUGRA_HUB='wss://hub.example.com/agent'\n"+script, dir, env...)
	if strings.Contains(out, "secretvalue") {
		t.Fatalf("the probe printed an environment value: %s", out)
	}
	return ParseProbe(out)
}

func TestProbeScriptDistinguishesOursForeignStoppedNone(t *testing.T) {
	cases := []struct {
		name string
		env  []string
		want string
	}{
		{"none", []string{"STUB_PRESENT=0"}, "none"},
		{"ours", []string{"STUB_PRESENT=1", "STUB_RUNNING=true", "STUB_HUB=wss://hub.example.com/agent"}, "ours"},
		{"stopped", []string{"STUB_PRESENT=1", "STUB_RUNNING=false", "STUB_HUB=wss://hub.example.com/agent"}, "stopped"},
		{"foreign", []string{"STUB_PRESENT=1", "STUB_RUNNING=true", "STUB_HUB=wss://other.example.org/agent"}, "foreign_hub"},
	}
	for _, c := range cases {
		r := probeWith(t, c.env...)
		if !r.Complete || r.Values["agent"] != c.want {
			t.Errorf("%s: complete=%v values=%v", c.name, r.Complete, r.Values)
		}
	}
	r := probeWith(t, "STUB_PRESENT=0")
	if r.Values["docker_present"] != "yes" || r.Values["docker_access"] != "yes" || r.Values["hub"] != "yes" || r.Values["arch"] == "" {
		t.Fatalf("%v", r.Values)
	}
}

func TestProbeScriptWithoutDockerIsAFindingNotAnError(t *testing.T) {
	dir := stubDir(t, map[string]string{})
	script, _ := ScriptFor("probe")
	r := ParseProbe(runScript(t, script, dir))
	// no docker stub: the host's own docker (if any) may exist, so only require a complete, well-formed reply
	if !r.Complete || r.Values["uid"] == "" {
		t.Fatalf("%v", r.Values)
	}
}

func uninstallWith(t *testing.T, cid string, env ...string) (string, string) {
	t.Helper()
	log := filepath.Join(t.TempDir(), "calls")
	dir := stubDir(t, map[string]string{"docker": `
echo "$*" >> "$STUB_LOG"
case "$1" in
  inspect)
    case "$*" in
      *"{{.Id}}"*) echo "$STUB_ID" ;;
      *"Config.Env"*) printf 'TUGRA_HUB=%s\n' "$STUB_HUB" ;;
    esac ;;
esac
exit 0
`})
	script, _ := ScriptFor("uninstall")
	out := runScript(t, "export TUGRA_HUB='wss://hub.example.com/agent'\nexport TUGRA_CID='"+cid+"'\n"+script, dir, append(env, "STUB_LOG="+log)...)
	b, _ := os.ReadFile(log)
	return out, string(b)
}

func TestUninstallScriptRemovesOnlyTheVerifiedContainer(t *testing.T) {
	out, calls := uninstallWith(t, tCID, "STUB_ID="+tCID, "STUB_HUB=wss://hub.example.com/agent")
	if !strings.Contains(out, "TUGRA_UNINSTALL ok") || !strings.Contains(calls, "rm "+tCID) || !strings.Contains(calls, "volume rm tugra-agent-data") {
		t.Fatalf("out=%q calls=%q", out, calls)
	}
	// another container is running under that name: nothing is stopped or removed
	other := strings.Repeat("f", 64)
	out, calls = uninstallWith(t, tCID, "STUB_ID="+other, "STUB_HUB=wss://hub.example.com/agent")
	if !strings.Contains(out, "refused_id") || strings.Contains(calls, " rm ") || strings.Contains(calls, "stop") || strings.Contains(calls, "volume") {
		t.Fatalf("out=%q calls=%q", out, calls)
	}
	// same id, but it belongs to another hub
	out, calls = uninstallWith(t, tCID, "STUB_ID="+tCID, "STUB_HUB=wss://other.example.org/agent")
	if !strings.Contains(out, "refused_hub") || strings.Contains(calls, "stop") || strings.Contains(calls, "rm ") {
		t.Fatalf("out=%q calls=%q", out, calls)
	}
	// a malformed id (a name, a short id, an option) is refused before docker is called at all
	for _, bad := range []string{"tugra-agent", "abc123", "--force", ""} {
		out, calls = uninstallWith(t, bad, "STUB_ID="+tCID)
		if !strings.Contains(out, "refused_id") || calls != "" {
			t.Fatalf("%q: out=%q calls=%q", bad, out, calls)
		}
	}
}
