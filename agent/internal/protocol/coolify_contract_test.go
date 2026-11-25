package protocol

import "testing"

// The names are a contract with @tugra/shared (COOLIFY_RUN_CAPABILITIES, AGENT_FEATURE_COOLIFY_*): a typo on either side makes the hub grant a
// capability the agent never matches.
func TestCoolifyTakeoverNamesMirrorShared(t *testing.T) {
	want := []string{"coolify_secrets", "coolify_ssh", "coolify_takeover", "coolify_cleanup"}
	if len(CoolifyRunCapabilities) != len(want) {
		t.Fatalf("capabilities: got %v want %v", CoolifyRunCapabilities, want)
	}
	for i, c := range want {
		if CoolifyRunCapabilities[i] != c {
			t.Fatalf("capability %d: got %q want %q", i, CoolifyRunCapabilities[i], c)
		}
	}
	flags := map[string]string{
		FeatureCoolifySecrets: "coolify_secrets_v1", FeatureCoolifySSH: "coolify_ssh_v1",
		FeatureCoolifyTakeover: "coolify_takeover_v1", FeatureCoolifyCleanup: "coolify_cleanup_v1",
	}
	for got, exp := range flags {
		if got != exp {
			t.Fatalf("feature flag: got %q want %q", got, exp)
		}
	}
}

// Advertising a feature the agent does not implement would make the hub send a frame nobody handles: none of the takeover flags is advertised yet.
func TestCoolifyTakeoverFeaturesNotAdvertisedYet(t *testing.T) {
	banned := map[string]bool{FeatureCoolifySecrets: true, FeatureCoolifySSH: true, FeatureCoolifyTakeover: true, FeatureCoolifyCleanup: true}
	for _, f := range Features {
		if banned[f] {
			t.Fatalf("feature %q is advertised before its lane implemented the frame", f)
		}
	}
}

// None of the takeover capabilities is a name the existing command path treats specially: a command signed for one is still just a capability string.
func TestCoolifyCapabilitiesAreDistinctFromExistingOnes(t *testing.T) {
	existing := []string{"deploy", "database", "backup", "cleanup", "bulk", "terminal", "schedule", "patch", "logs", "swarm", "files", "files_write", "migrate"}
	for _, c := range CoolifyRunCapabilities {
		for _, e := range existing {
			if c == e {
				t.Fatalf("%q collides with an existing capability", c)
			}
		}
	}
}
