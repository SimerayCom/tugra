// Package keys manages the agent's ed25519 identity. The private key is
// generated on-box and never leaves the machine.
package keys

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
)

type KeyPair struct {
	priv ed25519.PrivateKey
}

// New generates a fresh in-memory keypair.
func New() *KeyPair {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	return &KeyPair{priv: priv}
}

// LoadOrCreate loads the key from path, or generates and persists one (0600).
func LoadOrCreate(path string) (*KeyPair, error) {
	if b, err := os.ReadFile(path); err == nil {
		seed, err := base64.StdEncoding.DecodeString(string(b))
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("invalid key file at %s", path)
		}
		return &KeyPair{priv: ed25519.NewKeyFromSeed(seed)}, nil
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	enc := base64.StdEncoding.EncodeToString(priv.Seed())
	if err := os.WriteFile(path, []byte(enc), 0o600); err != nil {
		return nil, err
	}
	return &KeyPair{priv: priv}, nil
}

func (k *KeyPair) Public() ed25519.PublicKey {
	return k.priv.Public().(ed25519.PublicKey)
}

// PublicKeySPKIBase64 returns base64(SPKI DER) — what the hub stores/verifies.
func (k *KeyPair) PublicKeySPKIBase64() (string, error) {
	der, err := x509.MarshalPKIXPublicKey(k.priv.Public())
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(der), nil
}

// SignBase64 signs msg and returns base64(signature).
func (k *KeyPair) SignBase64(msg string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(k.priv, []byte(msg)))
}
