package keys

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"path/filepath"
	"testing"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	kp := New()
	sig, err := base64.StdEncoding.DecodeString(kp.SignBase64("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(kp.Public(), []byte("hello"), sig) {
		t.Fatal("signature did not verify")
	}
}

func TestPublicKeySPKIParses(t *testing.T) {
	kp := New()
	b64, err := kp.PublicKeySPKIBase64()
	if err != nil {
		t.Fatal(err)
	}
	der, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := x509.ParsePKIXPublicKey(der); err != nil {
		t.Fatalf("SPKI did not parse: %v", err)
	}
}

func TestLoadOrCreatePersists(t *testing.T) {
	p := filepath.Join(t.TempDir(), "agent.key")
	k1, err := LoadOrCreate(p)
	if err != nil {
		t.Fatal(err)
	}
	k2, err := LoadOrCreate(p)
	if err != nil {
		t.Fatal(err)
	}
	// ed25519 signing is deterministic → same key yields the same signature.
	if k1.SignBase64("x") != k2.SignBase64("x") {
		t.Fatal("reloaded key differs from persisted key")
	}
}
