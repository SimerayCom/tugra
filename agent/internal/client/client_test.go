package client

import "testing"

func TestAllowsCapability(t *testing.T) {
	// empty allowlist = no restrictions
	if !allowsCapability(nil, "bulk") {
		t.Fatal("empty allowlist should allow everything")
	}
	// restricted list
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
