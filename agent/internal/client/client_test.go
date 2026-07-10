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
