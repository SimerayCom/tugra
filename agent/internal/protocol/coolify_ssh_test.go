package protocol

import (
	"strings"
	"testing"
)

// The literal below is the same one the shared spec asserts (packages/shared/src/coolify-ssh.spec.ts).
func TestCanonicalCoolifySSHSharedVector(t *testing.T) {
	got := CanonicalCoolifySSH(CoolifySSHFields{
		ReqID: "r1", Op: "probe", CoolifyServerUUID: "abc123def456", ScriptSha256: strings.Repeat("a", 64), PayloadSha256: strings.Repeat("b", 64),
		UseSudo: false, ExpectedHostKeyFp: "", Exp: 1800000000, Capability: "coolify_ssh",
	})
	want := "cssh\n2:r1\n5:probe\n12:abc123def456\n64:" + strings.Repeat("a", 64) + "\n64:" + strings.Repeat("b", 64) + "\n1:0\n0:\n10:1800000000\n11:coolify_ssh"
	if got != want {
		t.Fatalf("canonical mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestCanonicalCoolifySSHSudoFlagIsSigned(t *testing.T) {
	f := CoolifySSHFields{ReqID: "r", Op: "install", CoolifyServerUUID: "abc123def456", Exp: 1, Capability: "coolify_ssh"}
	a := CanonicalCoolifySSH(f)
	f.UseSudo = true
	if CanonicalCoolifySSH(f) == a {
		t.Fatal("useSudo must change the signed text")
	}
}

func TestCoolifySSHCodesAreTheTwentyOne(t *testing.T) {
	if len(CoolifySSHCodes) != 21 {
		t.Fatalf("got %d codes", len(CoolifySSHCodes))
	}
}
