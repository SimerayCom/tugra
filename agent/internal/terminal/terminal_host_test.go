package terminal

import (
	"strings"
	"testing"
)

func TestHostShellEntersHostNamespacesFromOwnImage(t *testing.T) {
	cmd := hostShellCommand("ghcr.io/simeraycom/tugra-agent:0.1.0-beta.30", "tugra-host-shell-1")
	args := strings.Join(cmd.Args, " ")
	for _, want := range []string{
		"docker run --rm -i -t",
		"--name tugra-host-shell-1",
		"--pull never",
		"--pid host",
		"--entrypoint nsenter ghcr.io/simeraycom/tugra-agent:0.1.0-beta.30",
		"-t 1 -m -u -i -n -p -- sh -c",
	} {
		if !strings.Contains(args, want) {
			t.Fatalf("host shell command missing %q:\n%s", want, args)
		}
	}
	if last := cmd.Args[len(cmd.Args)-1]; !strings.Contains(last, "exec bash -l") {
		t.Fatalf("expected a login shell so the host profile (nvm, pm2) loads, got %q", last)
	}
}
