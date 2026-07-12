package protocol

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"testing"
)

func TestCanonicalStrings(t *testing.T) {
	if got := CanonicalCommand("r1", "echo hi", 5000, "deploy"); got != "cmd\nr1\necho hi\n5000\ndeploy" {
		t.Fatalf("CanonicalCommand mismatch: %q", got)
	}
	if got := CanonicalTermStart("s1", "tugra_app1", 80, 24, "terminal"); got != "term\ns1\ntugra_app1\n80\n24\nterminal" {
		t.Fatalf("CanonicalTermStart mismatch: %q", got)
	}
	// Must be byte-identical to @tugra/shared canonicalLogStart.
	if got := CanonicalLogStart("st1", "tugra_app1", 200, true, "1h", "err", "logs"); got != "logs\nst1\ntugra_app1\n200\n1\n1h\nerr\nlogs" {
		t.Fatalf("CanonicalLogStart(follow) mismatch: %q", got)
	}
	if got := CanonicalLogStart("st1", "c", 50, false, "", "", "logs"); got != "logs\nst1\nc\n50\n0\n\n\nlogs" {
		t.Fatalf("CanonicalLogStart(no-follow) mismatch: %q", got)
	}
}

func hubKeyB64(t *testing.T, pub ed25519.PublicKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(der)
}

func TestVerifySigRoundTripAndTamper(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	// agent parses the SPKI hub key exactly as delivered over the wire
	parsed, err := ParseHubKey(hubKeyB64(t, pub))
	if err != nil {
		t.Fatalf("ParseHubKey: %v", err)
	}

	canonical := CanonicalCommand("r1", "echo hi", 5000, "deploy")
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(canonical)))

	if !VerifySig(parsed, canonical, sig) {
		t.Fatal("expected valid signature to verify")
	}
	// tampered command must not verify against the original signature
	if VerifySig(parsed, CanonicalCommand("r1", "rm -rf /", 5000, "deploy"), sig) {
		t.Fatal("tampered command verified — signature check is broken")
	}
	// capability-relabel must not verify (anti-downgrade: bulk sig can't become deploy)
	if VerifySig(parsed, CanonicalCommand("r1", "echo hi", 5000, "bulk"), sig) {
		t.Fatal("capability-relabel verified — capability not bound to signature")
	}
	if VerifySig(parsed, canonical, "not-base64-!!") {
		t.Fatal("garbage signature verified")
	}
	if VerifySig(nil, canonical, sig) {
		t.Fatal("nil key verified (fail-closed expected)")
	}
}
