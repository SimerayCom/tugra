package selfupdate

import (
	"strings"
	"testing"
)

func TestValidateImageRef(t *testing.T) {
	good := []string{"ghcr.io/simeraycom/tugra-agent:0.2.0", "registry.internal:5000/agent:1.0.0", "a/b@sha256:abc"}
	for _, g := range good {
		if err := ValidateImageRef(g); err != nil {
			t.Errorf("ValidateImageRef(%q) = %v, want nil", g, err)
		}
	}
	bad := []string{"", "img; rm -rf /", "img $(whoami)", "img\nrun", "img`x`", "img&&x"}
	for _, b := range bad {
		if err := ValidateImageRef(b); err == nil {
			t.Errorf("ValidateImageRef(%q) = nil, want error", b)
		}
	}
}

func TestValidateSha256(t *testing.T) {
	if err := ValidateSha256(strings.Repeat("a", 64)); err != nil {
		t.Errorf("valid 64-hex rejected: %v", err)
	}
	for _, b := range []string{"", "abc", strings.Repeat("a", 63), strings.Repeat("A", 64), strings.Repeat("g", 64), "sha256:" + strings.Repeat("a", 64)} {
		if err := ValidateSha256(b); err == nil {
			t.Errorf("ValidateSha256(%q) = nil, want error", b)
		}
	}
}

func TestShouldApply(t *testing.T) {
	cases := []struct {
		self, target        string
		wantApply, wantNoop bool
	}{
		{"0.1.0", "0.2.0", true, false},      // older → apply
		{"0.2.0", "0.2.0", false, true},      // exact-equal → noop
		{"0.3.0", "0.2.0", false, false},     // newer → refuse downgrade
		{"1.0.0", "2.0.0", true, false},      // major bump → apply
		{"0.3.0-rc.2", "0.3.0", true, false}, // prerelease → GA is a REAL upgrade (not a noop)
		{"garbage", "0.2.0", true, false},    // unparseable → fail-open apply
		{"0.2.0", "weird", true, false},      // unparseable target → fail-open apply
	}
	for _, c := range cases {
		apply, noop := ShouldApply(c.self, c.target)
		if apply != c.wantApply || noop != c.wantNoop {
			t.Errorf("ShouldApply(%q,%q) = (apply=%v,noop=%v), want (apply=%v,noop=%v)", c.self, c.target, apply, noop, c.wantApply, c.wantNoop)
		}
	}
}

func TestBuildRecreateInvocation(t *testing.T) {
	argv, script, err := BuildRecreateInvocation(RecreateSpec{
		SelfName:    "tugra-agent",
		DataVolume:  "tugra-agent-data",
		HubURL:      "wss://hub.example.com/agent",
		NewImageRef: "ghcr.io/simeraycom/tugra-agent:0.2.0@sha256:abc",
		OldImageRef: "ghcr.io/simeraycom/tugra-agent:0.1.0",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// The detached helper is the NEW image run with an sh entrypoint; dynamic values are -e argv (no shell
	// on the agent side). Assert the full argv byte-for-byte.
	want := []string{
		"docker", "run", "-d", "--rm", "--entrypoint", "/bin/sh",
		"-v", "/var/run/docker.sock:/var/run/docker.sock",
		"-e", "SELF=tugra-agent",
		"-e", "DATA_VOL=tugra-agent-data",
		"-e", "HUB=wss://hub.example.com/agent",
		"-e", "NEW_IMAGE=ghcr.io/simeraycom/tugra-agent:0.2.0@sha256:abc",
		"-e", "OLD_IMAGE=ghcr.io/simeraycom/tugra-agent:0.1.0",
		"ghcr.io/simeraycom/tugra-agent:0.2.0@sha256:abc", "-c", script,
	}
	if len(argv) != len(want) {
		t.Fatalf("argv len = %d, want %d\n got: %#v", len(argv), len(want), argv)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Fatalf("argv[%d] = %q, want %q", i, argv[i], want[i])
		}
	}

	// The inner script must reference values ONLY via quoted env vars (no interpolation), never carry the
	// single-use token, health-gate the new container, and fall back to the OLD image so the host is never
	// left agentless.
	for _, must := range []string{
		`-e TUGRA_HUB="$HUB" -e TUGRA_AGENT_IMAGE="$NEW_IMAGE" "$NEW_IMAGE"`,
		`-e TUGRA_HUB="$HUB" -e TUGRA_AGENT_IMAGE="$OLD_IMAGE" "$OLD_IMAGE"`,
		`-v /etc/tugra:/etc/tugra`,
		`{{.State.Running}}`, // health gate: exit-0 of `docker run -d` is not "healthy"
		`{{.RestartCount}}`,
	} {
		if !strings.Contains(script, must) {
			t.Errorf("inner script missing %q\n---\n%s", must, script)
		}
	}
	// A rm -f must precede BOTH runs so a leftover container never blocks the fallback on a name conflict.
	if strings.Count(script, `docker rm -f "$SELF"`) < 2 {
		t.Errorf("expected a `docker rm -f \"$SELF\"` before both the new and fallback runs\n---\n%s", script)
	}
	if strings.Contains(script, "TUGRA_TOKEN") {
		t.Error("inner script must NOT carry TUGRA_TOKEN (recreated agent re-auths via the volume identity)")
	}
}

func TestBuildRecreateInvocationReAttachesNetworks(t *testing.T) {
	// Single compose network: applied at create time via --network, no connect loop.
	argv, script, err := BuildRecreateInvocation(RecreateSpec{
		SelfName: "tugra-agent", DataVolume: "tugra-agent-data", HubURL: "ws://hub-api:3000/agent",
		NewImageRef: "img@sha256:abc", OldImageRef: "old", Networks: []string{"tugra_default"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(script, `docker run -d --name "$SELF" --restart unless-stopped --network "$NET" -v`) {
		t.Errorf("recreate run must carry --network \"$NET\"\n---\n%s", script)
	}
	if !argvHas(argv, "-e", "NET=tugra_default") {
		t.Errorf("argv must pass -e NET=tugra_default, got %#v", argv)
	}
	if argvHasKey(argv, "EXTRA_NETS=") || strings.Contains(script, "EXTRA_NETS") {
		t.Errorf("a single network must NOT emit EXTRA_NETS\n---\n%s\n%#v", script, argv)
	}

	// Multiple networks: first via --network, the rest connected after each run.
	argv2, script2, err := BuildRecreateInvocation(RecreateSpec{
		SelfName: "tugra-agent", DataVolume: "tugra-agent-data", HubURL: "ws://hub-api:3000/agent",
		NewImageRef: "img@sha256:abc", OldImageRef: "old", Networks: []string{"tugra_default", "extra_net"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !argvHas(argv2, "-e", "NET=tugra_default") || !argvHas(argv2, "-e", "EXTRA_NETS=extra_net") {
		t.Errorf("argv must pass NET + EXTRA_NETS, got %#v", argv2)
	}
	if !strings.Contains(script2, `for n in $EXTRA_NETS; do docker network connect "$n" "$SELF"`) {
		t.Errorf("multi-network recreate must connect the extras\n---\n%s", script2)
	}
	// The extras must be connected after BOTH the new-image run and the old-image fallback.
	if strings.Count(script2, "docker network connect") < 2 {
		t.Errorf("extras must be connected after both the new and fallback runs\n---\n%s", script2)
	}
}

func TestBuildRecreateInvocationDropsUnsafeNetwork(t *testing.T) {
	// A network name that fails the charset check is DROPPED, never injected into the docker command.
	argv, script, err := BuildRecreateInvocation(RecreateSpec{
		SelfName: "tugra-agent", DataVolume: "tugra-agent-data", HubURL: "ws://h",
		NewImageRef: "img@sha256:abc", OldImageRef: "old", Networks: []string{"tugra_default", "bad;rm -rf /"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, s := range append([]string{script}, argv...) {
		if strings.Contains(s, "bad;rm") || strings.Contains(s, "rm -rf") {
			t.Fatalf("unsafe network name leaked into the invocation: %q", s)
		}
	}
	// The valid one still survives as the primary; the dropped one leaves no EXTRA_NETS.
	if !argvHas(argv, "-e", "NET=tugra_default") || argvHasKey(argv, "EXTRA_NETS=") {
		t.Errorf("expected only the valid network as primary, got %#v", argv)
	}
}

func TestBuildRecreateInvocationNoNetworksIsHistorical(t *testing.T) {
	// No networks → the recreate carries NO --network (historical bridge behaviour), so a remote agent on a
	// public hub URL is unaffected.
	_, script, err := BuildRecreateInvocation(RecreateSpec{
		SelfName: "tugra-agent", DataVolume: "tugra-agent-data", HubURL: "wss://hub.example.com/agent",
		NewImageRef: "img@sha256:abc", OldImageRef: "old",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(script, "--network") {
		t.Errorf("no-networks recreate must not carry --network\n---\n%s", script)
	}
}

func TestOrderNetworks(t *testing.T) {
	got := orderNetworks([]string{"bridge", "tugra_default", "tugra_default", "", "tugra-panel"})
	want := []string{"tugra_default", "tugra-panel", "bridge"} // user-defined first (deduped), bridge last
	if len(got) != len(want) {
		t.Fatalf("orderNetworks = %#v, want %#v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("orderNetworks[%d] = %q, want %q (full %#v)", i, got[i], want[i], got)
		}
	}
	if n := orderNetworks([]string{"bridge"}); len(n) != 1 || n[0] != "bridge" {
		t.Errorf("a bridge-only agent must stay [bridge], got %#v", n)
	}
}

func argvHas(argv []string, flag, val string) bool {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == flag && argv[i+1] == val {
			return true
		}
	}
	return false
}

func argvHasKey(argv []string, prefix string) bool {
	for _, a := range argv {
		if strings.HasPrefix(a, prefix) {
			return true
		}
	}
	return false
}

func TestBuildRecreateInvocationRejectsBadInput(t *testing.T) {
	base := RecreateSpec{SelfName: "tugra-agent", DataVolume: "tugra-agent-data", HubURL: "ws://h", NewImageRef: "img@sha256:x", OldImageRef: "old"}
	bad := []RecreateSpec{
		func() RecreateSpec { s := base; s.SelfName = "bad;name"; return s }(),
		func() RecreateSpec { s := base; s.DataVolume = "vol name"; return s }(),
		func() RecreateSpec { s := base; s.OldImageRef = ""; return s }(), // no fallback → refuse
		func() RecreateSpec { s := base; s.HubURL = ""; return s }(),
	}
	for i, s := range bad {
		if _, _, err := BuildRecreateInvocation(s); err == nil {
			t.Errorf("case %d: expected error for %#v", i, s)
		}
	}
}
