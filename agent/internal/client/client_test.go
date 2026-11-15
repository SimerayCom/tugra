package client

import "testing"

func TestAllowsCapability(t *testing.T) {
	// FAIL-CLOSED: an empty allowlist denies everything (deny-by-default).
	if allowsCapability(nil, "bulk") {
		t.Fatal("empty allowlist must DENY (fail-closed)")
	}
	if allowsCapability([]string{}, "deploy") {
		t.Fatal("empty (non-nil) allowlist must DENY (fail-closed)")
	}
	// A restricted list allows only its members.
	allowed := []string{"deploy", "database", "backup", "cleanup"}
	if !allowsCapability(allowed, "deploy") {
		t.Fatal("deploy should be allowed")
	}
	if allowsCapability(allowed, "bulk") {
		t.Fatal("bulk should be rejected when not in the allowlist")
	}
	if allowsCapability(allowed, "terminal") {
		t.Fatal("terminal should be rejected when not in the allowlist")
	}
}

func TestCapState(t *testing.T) {
	// Starts empty → deny everything (fail-closed).
	cs := newCapState(nil, false)
	if cs.allows("deploy") {
		t.Fatal("fresh capState (empty) must deny")
	}
	// Hub pushes a granted set → those are allowed, others denied.
	cs.set([]string{"deploy", "backup"})
	if !cs.allows("deploy") {
		t.Fatal("deploy should be allowed after the hub grants it")
	}
	if cs.allows("terminal") {
		t.Fatal("terminal should stay denied (not granted)")
	}
	// Hub narrows to deny-all → nothing allowed (live update).
	cs.set([]string{})
	if cs.allows("deploy") {
		t.Fatal("after the hub revokes everything, deploy must be denied")
	}

	// Bypass escape hatch (--caps=all) allows everything regardless of the pushed set.
	byp := newCapState(nil, true)
	if !byp.allows("terminal") || !byp.allows("deploy") {
		t.Fatal("bypass must allow every capability")
	}
	byp.set([]string{"deploy"}) // a hub push must NOT override the operator bypass
	if !byp.allows("terminal") {
		t.Fatal("bypass must persist even after a hub capabilities push")
	}
}

// TUGRA_HUB_ORIGIN is exported to `backup` commands ONLY, derived from the agent's own configured hub URL.
func TestCommandEnvScopedToBackupCapability(t *testing.T) {
	env := commandEnv("wss://hub.example.com:8443/ws/agent", "backup")
	if len(env) != 1 || env[0] != "TUGRA_HUB_ORIGIN=https://hub.example.com:8443" {
		t.Fatalf("backup command must get the origin of the agent's own hub URL, got %v", env)
	}
	if env := commandEnv("ws://10.0.0.5:3000/ws", "backup"); len(env) != 1 || env[0] != "TUGRA_HUB_ORIGIN=http://10.0.0.5:3000" {
		t.Fatalf("ws must map to http, got %v", env)
	}
	for _, c := range []string{"deploy", "database", "cleanup", "terminal", "files_write", ""} {
		if env := commandEnv("wss://hub.example.com/ws", c); env != nil {
			t.Fatalf("capability %q must NOT see the hub origin, got %v", c, env)
		}
	}
	// A hub URL the agent cannot derive an origin from fails closed: no env at all.
	if env := commandEnv("ftp://hub.example.com", "backup"); env != nil {
		t.Fatalf("unsupported scheme must yield no env, got %v", env)
	}
	if env := commandEnv("::not a url", "backup"); env != nil {
		t.Fatalf("unparseable URL must yield no env, got %v", env)
	}
}
