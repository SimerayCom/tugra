package hostinfo

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A real ed25519 public key and the fingerprint `ssh-keygen -l -E sha256` prints for it.
const (
	testPub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINglB2EoQEA0+ExQ8QyASuzmcrcM2xcyezADVZ9kNCsW test"
	testFp  = "SHA256:1kohlgcS1XMZ4aLVaDZT2z7vYLgvfjGmEdyf4Ze9kbU"
)

func TestSSHHostKeyFingerprintMatchesSSHKeygen(t *testing.T) {
	fp, ok := SSHHostKeyFingerprint(testPub)
	if !ok || fp != testFp {
		t.Fatalf("fingerprint = %q ok=%v, want %q", fp, ok, testFp)
	}
}

func TestSSHHostKeyFingerprintRefusesNonKeys(t *testing.T) {
	for _, bad := range []string{"", "ssh-ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----", "ssh-dss AAAA", "ssh-ed25519 !!!notbase64", "rm -rf / AAAA", "ssh-ed25519 " + strings.Repeat("A", 2100)} {
		if fp, ok := SSHHostKeyFingerprint(bad); ok || fp != "" {
			t.Errorf("SSHHostKeyFingerprint(%q) = %q, %v; want refusal", bad, fp, ok)
		}
	}
}

func TestSSHHostKeyArgsMountOnlyOnePublicKeyAndNoNetwork(t *testing.T) {
	args, err := SSHHostKeyArgs("ghcr.io/simeraycom/tugra-agent:0.1.0-beta.25@sha256:abc", "ed25519")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"--rm", "--network none", "--read-only", "--cap-drop ALL", "no-new-privileges", "--entrypoint tugra-agent", "source=/etc/ssh/ssh_host_ed25519_key.pub,target=/hostkey.pub,readonly"} {
		if !strings.Contains(joined, want) {
			t.Errorf("helper argv missing %q: %s", want, joined)
		}
	}
	if strings.Contains(joined, "_key,") || strings.Contains(joined, "source=/etc/ssh,") || strings.Contains(joined, "--privileged") {
		t.Errorf("helper argv must mount one public key file only: %s", joined)
	}
	if args[len(args)-1] != "hostsshkey" {
		t.Errorf("last arg = %q, want hostsshkey", args[len(args)-1])
	}
	for _, bad := range []string{"", "-v", "--privileged", "img; rm -rf /", "img $(id)"} {
		if _, err := SSHHostKeyArgs(bad, "rsa"); err == nil {
			t.Errorf("SSHHostKeyArgs(%q) accepted an invalid image", bad)
		}
	}
	for _, bad := range []string{"", "dsa", "../../etc/shadow", "ed25519,readonly=false", "rsa_key"} {
		if _, err := SSHHostKeyArgs("img", bad); err == nil {
			t.Errorf("SSHHostKeyArgs accepted key type %q", bad)
		}
	}
}

func TestPrintSSHHostKeyFp(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.pub")
	if err := os.WriteFile(good, []byte(testPub+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := PrintSSHHostKeyFp(good, &out); code != 0 || strings.TrimSpace(out.String()) != testFp {
		t.Fatalf("PrintSSHHostKeyFp = %d %q, want 0 %q", code, out.String(), testFp)
	}
	// A private key (or anything that is not a public key line) is never echoed.
	priv := filepath.Join(dir, "priv")
	if err := os.WriteFile(priv, []byte("-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETSECRET\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if code := PrintSSHHostKeyFp(priv, &out); code == 0 || out.Len() != 0 {
		t.Fatalf("a non-public key must print nothing and fail, got %d %q", code, out.String())
	}
	if code := PrintSSHHostKeyFp(filepath.Join(dir, "missing"), &out); code == 0 {
		t.Fatal("a missing file must fail")
	}
}
