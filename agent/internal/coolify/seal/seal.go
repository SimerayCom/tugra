// Package seal makes the "tse1" envelope: one secret value sealed to a recipient X25519 public key, with the standard library only
// (crypto/ecdh, crypto/hkdf, crypto/aes, crypto/cipher). There is deliberately no Open here: the agent can seal a value and never
// open one. The hub opens it (Node's crypto) with the per-run private key, which the agent never holds.
//
// Layout of `tse1.` + base64url(no padding) of:  ephemeralPublicKey(32) | nonce(12) | AES-256-GCM(framed) | tag(16)
// framed = uint32 big-endian length | value | zero padding, to a multiple of 64 bytes (hides the length of short values).
// The AES key is HKDF-SHA256(secret = X25519(ephemeral, recipient), salt = runId, info = "tugra/coolify-secret/v1" + keyId, 32 bytes)
// with keyId = the first 16 hex characters of SHA-256(recipient public key). The AAD binds the value to where it came from:
// runId, agent server id, ref (kind:uuid), field and class, NUL separated. An envelope moved to another field or run does not open.
package seal

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"strings"
)

const (
	Prefix   = "tse1."
	HKDFInfo = "tugra/coolify-secret/v1"
	PadBytes = 64
	// MaxValue is the largest value one envelope carries; a bigger value is `too_large` (reported by the caller).
	MaxValue = 1 << 20
)

// Context is everything a value is bound to.
type Context struct {
	RunID, ServerID, Ref, Field, Class string
}

var (
	ErrRecipient = errors.New("bad recipient key")
	ErrContext   = errors.New("bad context")
	ErrTooLarge  = errors.New("value too large")
)

// ParseRecipient decodes the base64 public key and refuses anything that is not a usable X25519 point: wrong length, or a small-order
// point (an attacker-chosen recipient that would make every shared secret the same known value). The small-order check is a real
// ECDH against a throwaway key: crypto/ecdh rejects an all-zero shared secret.
func ParseRecipient(b64 string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) != 32 {
		return nil, ErrRecipient
	}
	pub, err := ecdh.X25519().NewPublicKey(raw)
	if err != nil {
		return nil, ErrRecipient
	}
	probe := make([]byte, 32)
	probe[0] = 9
	priv, err := ecdh.X25519().NewPrivateKey(probe)
	if err != nil {
		return nil, ErrRecipient
	}
	if _, err := priv.ECDH(pub); err != nil {
		return nil, ErrRecipient
	}
	return raw, nil
}

// KeyID is the short id of a recipient key, used in the HKDF info so a key id mix-up fails closed.
func KeyID(recipient []byte) string {
	h := sha256.Sum256(recipient)
	return hex.EncodeToString(h[:])[:16]
}

// AAD is the associated data of the envelope. The parts never contain NUL (the callers validate them), so the encoding is injective.
func AAD(c Context) ([]byte, error) {
	for _, p := range []string{c.RunID, c.ServerID, c.Ref, c.Field, c.Class} {
		if p == "" || strings.ContainsRune(p, 0) {
			return nil, ErrContext
		}
	}
	return []byte(strings.Join([]string{c.RunID, c.ServerID, c.Ref, c.Field, c.Class}, "\x00")), nil
}

// Seal seals plain to the recipient. rnd supplies the ephemeral private key (32 bytes) then the nonce (12 bytes); in production it is
// crypto/rand.Reader and a test passes a fixed stream to get a fixed envelope.
func Seal(rnd io.Reader, recipient []byte, c Context, plain []byte) (string, error) {
	if len(plain) > MaxValue {
		return "", ErrTooLarge
	}
	aad, err := AAD(c)
	if err != nil {
		return "", err
	}
	rpub, err := ecdh.X25519().NewPublicKey(recipient)
	if err != nil {
		return "", ErrRecipient
	}
	seed := make([]byte, 32)
	nonce := make([]byte, 12)
	if _, err := io.ReadFull(rnd, seed); err != nil {
		return "", err
	}
	if _, err := io.ReadFull(rnd, nonce); err != nil {
		return "", err
	}
	eph, err := ecdh.X25519().NewPrivateKey(seed)
	for i := range seed {
		seed[i] = 0
	}
	if err != nil {
		return "", err
	}
	shared, err := eph.ECDH(rpub)
	if err != nil {
		return "", ErrRecipient
	}
	key, err := hkdf.Key(sha256.New, shared, []byte(c.RunID), HKDFInfo+KeyID(recipient), 32)
	for i := range shared {
		shared[i] = 0
	}
	if err != nil {
		return "", err
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return "", err
	}
	framed := make([]byte, (4+len(plain)+PadBytes-1)/PadBytes*PadBytes)
	binary.BigEndian.PutUint32(framed, uint32(len(plain)))
	copy(framed[4:], plain)

	out := make([]byte, 0, 32+12+len(framed)+g.Overhead())
	out = append(out, eph.PublicKey().Bytes()...)
	out = append(out, nonce...)
	out = g.Seal(out, nonce, framed, aad)
	for i := range framed {
		framed[i] = 0
	}
	for i := range key {
		key[i] = 0
	}
	return Prefix + base64.RawURLEncoding.EncodeToString(out), nil
}
