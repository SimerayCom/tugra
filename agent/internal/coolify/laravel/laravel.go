// Package laravel opens the values Coolify's PHP framework encrypts at rest. It is a clean-room reader of the published payload
// format (base64 of a JSON object {iv, value, mac, tag}; AES-CBC with an HMAC-SHA256 over the base64 iv and value, or AES-GCM with
// a tag), written from the format alone. Nothing here touches the network, a file or a process: bytes in, bytes or a fixed code out.
//
// The package runs inside the sealed-secrets helper container, so it must stay free of anything that could send or persist a value.
// Errors carry a fixed wire code and never a message, a payload fragment or a key byte.
package laravel

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
)

// The fixed codes (mirror COOLIFY_SECRET_WIRE_CODES in @tugra/shared).
const (
	CodeBadMAC                   = "bad_mac"
	CodeBadPayload               = "bad_payload"
	CodeNoKey                    = "no_key"
	CodeUnsupportedCipher        = "unsupported_cipher"
	CodeUnsupportedSerialization = "unsupported_serialization"
	CodeTooLarge                 = "too_large"
)

// MaxPayloadBytes bounds one stored value (the base64 text). A larger one is `too_large`, never parsed.
const MaxPayloadBytes = 2 << 20

// Error is a failure with a fixed wire code. Its text is the code, nothing else.
type Error struct{ Code string }

func (e *Error) Error() string { return e.Code }

func fail(code string) error { return &Error{Code: code} }

// CodeOf returns the wire code of an error from this package ("bad_payload" for anything else, so nothing unclassified ever escapes).
func CodeOf(err error) string {
	if e, ok := err.(*Error); ok {
		return e.Code
	}
	return CodeBadPayload
}

// Form is how the plaintext of a column was produced.
type Form int

const (
	// FormString: the model's `encrypted` cast (encryptString): the plaintext is the value.
	FormString Form = iota
	// FormSerialized: encrypt() of a PHP string: the plaintext is s:<bytes>:"<value>"; and nothing else.
	FormSerialized
	// FormAuto: the column is not known. Accept the exact serialized string shape and unwrap it, otherwise take the plaintext as it is.
	FormAuto
)

// KeyRing is the app key followed by the previous keys, in the order they are tried.
type KeyRing struct {
	keys [][]byte
	err  string // a fixed code when the current key is unusable
}

// ParseKeyRing builds the ring from APP_KEY ("base64:<b64>" or a raw 16/32 byte string) and APP_PREVIOUS_KEYS (comma separated, same
// forms). An empty APP_KEY gives a ring whose every Open is `no_key`; a key of the wrong length gives `unsupported_cipher`.
// A previous key that does not parse is skipped.
func ParseKeyRing(appKey, previous string) *KeyRing {
	r := &KeyRing{}
	cur := strings.TrimSpace(appKey)
	if cur == "" {
		r.err = CodeNoKey
		return r
	}
	k, ok := parseKey(cur)
	if !ok {
		r.err = CodeUnsupportedCipher
		return r
	}
	r.keys = append(r.keys, k)
	for _, p := range strings.Split(previous, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		if pk, ok := parseKey(p); ok {
			r.keys = append(r.keys, pk)
		}
	}
	return r
}

func parseKey(s string) ([]byte, bool) {
	s = strings.Trim(s, `"'`)
	var k []byte
	if rest, ok := strings.CutPrefix(s, "base64:"); ok {
		d, err := base64.StdEncoding.DecodeString(rest)
		if err != nil {
			return nil, false
		}
		k = d
	} else {
		k = []byte(s)
	}
	if len(k) != 16 && len(k) != 32 {
		return nil, false
	}
	return k, true
}

// Zero overwrites the key bytes.
func (r *KeyRing) Zero() {
	for _, k := range r.keys {
		for i := range k {
			k[i] = 0
		}
	}
	r.keys = nil
}

// Result is an opened value.
type Result struct {
	Plain        []byte
	UsedPrevious bool // opened by a previous key
	WasPlaintext bool // the stored value was not encrypted at all (a row written before Coolify 4.5.0 encrypted that column)
}

type payload struct {
	IV    string `json:"iv"`
	Value string `json:"value"`
	MAC   string `json:"mac"`
	Tag   string `json:"tag"`
}

// parsePayload reports whether s has the Laravel shape (base64 of a JSON object with string iv, value and mac or tag).
func parsePayload(s string) (payload, bool) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(raw) == 0 || raw[0] != '{' {
		return payload{}, false
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return payload{}, false
	}
	var p payload
	for _, f := range []struct {
		k   string
		dst *string
		req bool
	}{{"iv", &p.IV, true}, {"value", &p.Value, true}, {"mac", &p.MAC, true}, {"tag", &p.Tag, false}} {
		v, ok := m[f.k]
		if !ok {
			if f.req {
				return payload{}, false
			}
			continue
		}
		if json.Unmarshal(v, f.dst) != nil {
			return payload{}, false
		}
	}
	return p, true
}

// Open decrypts one stored value. plainOK says the column may hold an unencrypted value from before Coolify 4.5.0: a stored value
// that does not have the Laravel shape is then returned as it is. A value that HAS the shape is never treated as plaintext, so a
// failed MAC stays `bad_mac` instead of passing a damaged ciphertext on as if it were the secret.
func (r *KeyRing) Open(stored string, form Form, plainOK bool) (Result, error) {
	if len(stored) > MaxPayloadBytes {
		return Result{}, fail(CodeTooLarge)
	}
	p, shaped := parsePayload(stored)
	if !shaped {
		if plainOK {
			return Result{Plain: []byte(stored), WasPlaintext: true}, nil
		}
		return Result{}, fail(CodeBadPayload)
	}
	if r.err != "" {
		return Result{}, fail(r.err)
	}
	iv, err1 := base64.StdEncoding.DecodeString(p.IV)
	val, err2 := base64.StdEncoding.DecodeString(p.Value)
	if err1 != nil || err2 != nil {
		return Result{}, fail(CodeBadPayload)
	}
	var tag []byte
	if p.Tag != "" {
		t, err := base64.StdEncoding.DecodeString(p.Tag)
		if err != nil {
			return Result{}, fail(CodeBadPayload)
		}
		tag = t
	}
	for i, key := range r.keys {
		var pt []byte
		var err error
		if len(tag) > 0 {
			pt, err = openGCM(key, iv, val, tag)
		} else {
			pt, err = openCBC(key, p.IV, p.Value, p.MAC, iv, val)
		}
		if err != nil {
			if CodeOf(err) == CodeBadMAC {
				continue // not this key; try the next
			}
			return Result{}, err // authenticated under this key but malformed: no other key will do better
		}
		out, err := finish(pt, form)
		if err != nil {
			return Result{}, err
		}
		return Result{Plain: out, UsedPrevious: i > 0}, nil
	}
	return Result{}, fail(CodeBadMAC)
}

func openGCM(key, iv, val, tag []byte) ([]byte, error) {
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, fail(CodeUnsupportedCipher)
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, fail(CodeUnsupportedCipher)
	}
	if len(iv) != g.NonceSize() || len(tag) != g.Overhead() {
		return nil, fail(CodeBadPayload)
	}
	buf := make([]byte, 0, len(val)+len(tag))
	buf = append(append(buf, val...), tag...)
	pt, err := g.Open(nil, iv, buf, nil)
	if err != nil {
		return nil, fail(CodeBadMAC)
	}
	return pt, nil
}

func openCBC(key []byte, ivB64, valB64, mac string, iv, val []byte) ([]byte, error) {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(ivB64))
	h.Write([]byte(valB64))
	want := hex.EncodeToString(h.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(mac)) {
		return nil, fail(CodeBadMAC)
	}
	// Only after the MAC passes is anything decrypted.
	blk, err := aes.NewCipher(key)
	if err != nil {
		return nil, fail(CodeUnsupportedCipher)
	}
	if len(iv) != aes.BlockSize || len(val) == 0 || len(val)%aes.BlockSize != 0 {
		return nil, fail(CodeBadPayload)
	}
	pt := make([]byte, len(val))
	cipher.NewCBCDecrypter(blk, iv).CryptBlocks(pt, val)
	n := int(pt[len(pt)-1])
	if n == 0 || n > aes.BlockSize || n > len(pt) {
		return nil, fail(CodeBadPayload)
	}
	for _, b := range pt[len(pt)-n:] {
		if int(b) != n {
			return nil, fail(CodeBadPayload)
		}
	}
	return pt[:len(pt)-n], nil
}

func finish(pt []byte, form Form) ([]byte, error) {
	switch form {
	case FormSerialized:
		return unwrapSerialized(pt)
	case FormAuto:
		if v, ok := parseSerializedString(pt); ok {
			return v, nil
		}
		return pt, nil
	default:
		return pt, nil
	}
}

// unwrapSerialized reads exactly s:<bytes>:"<value>"; . Every other PHP serialization (object, array, closure, number, bool, null...)
// is refused by name and is never interpreted: a payload cannot make this code build anything.
func unwrapSerialized(pt []byte) ([]byte, error) {
	if v, ok := parseSerializedString(pt); ok {
		return v, nil
	}
	if len(pt) >= 2 {
		switch pt[0] {
		case 'O', 'a', 'C', 'b', 'i', 'd', 'E', 'S', 'r', 'R':
			if pt[1] == ':' {
				return nil, fail(CodeUnsupportedSerialization)
			}
		case 'N':
			if pt[1] == ';' {
				return nil, fail(CodeUnsupportedSerialization)
			}
		}
	}
	return nil, fail(CodeBadPayload)
}

// parseSerializedString accepts the whole input only if it is one PHP string: s:<digits>:"<exactly that many bytes>";
func parseSerializedString(b []byte) ([]byte, bool) {
	if len(b) < 6 || b[0] != 's' || b[1] != ':' {
		return nil, false
	}
	i := 2
	for i < len(b) && b[i] >= '0' && b[i] <= '9' {
		i++
	}
	digits := string(b[2:i])
	if digits == "" || len(digits) > 9 || (len(digits) > 1 && digits[0] == '0') {
		return nil, false
	}
	if i+2 > len(b) || b[i] != ':' || b[i+1] != '"' {
		return nil, false
	}
	n, err := strconv.Atoi(digits)
	if err != nil {
		return nil, false
	}
	start := i + 2
	end := start + n
	if end < start || end+2 != len(b) || b[end] != '"' || b[end+1] != ';' {
		return nil, false
	}
	return b[start:end], true
}
