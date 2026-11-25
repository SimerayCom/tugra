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

// Advertising a feature the agent does not implement would make the hub send a frame nobody handles: a flag is advertised only by the lane
// that implemented its frame. Secrets (lane B) and SSH install (lane C) are implemented, so both must be advertised.
func TestCoolifyTakeoverFeaturesNotAdvertisedYet(t *testing.T) {
	banned := map[string]bool{FeatureCoolifyTakeover: true, FeatureCoolifyCleanup: true}
	for _, want := range []string{FeatureCoolifySecrets, FeatureCoolifySSH} {
		found := false
		for _, f := range Features {
			if f == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s must be advertised: its frame is implemented", want)
		}
	}
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

func TestCoolifySecretsFeatureIsAdvertised(t *testing.T) {
	for _, f := range Features {
		if f == FeatureCoolifySecrets {
			return
		}
	}
	t.Fatal("the secrets lane handles coolify_secrets_req, so its feature flag must be advertised")
}

// The signed bytes are a contract with @tugra/shared canonicalCoolifySecrets (the same expected string is asserted there).
func TestCanonicalCoolifySecretsGolden(t *testing.T) {
	got := CanonicalCoolifySecrets(CoolifySecretsFields{
		ServerID: "srv-1", ReqID: "req-1", RunID: "run-1", Classes: []string{"env", "s3"}, Refs: []string{"env:abc", "s3:xyz"},
		RecipientKey: "AAAA", Exp: 1800000000, Capability: "coolify_secrets",
	})
	want := "coolify_secrets\n5:srv-1\n5:req-1\n5:run-1\n6:env,s3\n14:env:abc,s3:xyz\n4:AAAA\n10:1800000000\n15:coolify_secrets"
	if got != want {
		t.Fatalf("canonical form drifted:\n got %q\nwant %q", got, want)
	}
	// A newline inside a field cannot shift another field (length prefixes).
	a := CanonicalCoolifySecrets(CoolifySecretsFields{ServerID: "a\n1:b", ReqID: "c"})
	b := CanonicalCoolifySecrets(CoolifySecretsFields{ServerID: "a", ReqID: "b\n1:c"})
	if a == b {
		t.Fatal("field boundary forged")
	}
}
