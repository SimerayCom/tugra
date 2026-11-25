package coolify

import (
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"strings"
)

// Host key handling for the SSH install. The fingerprint the hub stores and cross-checks is the one THIS agent saw on the wire (ssh-keyscan
// in a helper), never a value the target reported about itself.

// Fingerprint renders a public key blob the way ssh-keygen prints it: "SHA256:" + unpadded base64 of the sha256 of the blob.
func Fingerprint(blob []byte) string {
	sum := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

func isKeyType(s string) bool {
	return strings.HasPrefix(s, "ssh-") || strings.HasPrefix(s, "ecdsa-") || strings.HasPrefix(s, "sk-")
}

// KeyFingerprintsFromLines reads known_hosts-style lines ("host keytype base64 [comment]", or "keytype base64") and returns the
// fingerprint of every key in them, in order. Comment lines and anything unparseable are skipped.
func KeyFingerprintsFromLines(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(line)
		for i := 0; i+1 < len(f); i++ {
			if !isKeyType(f[i]) {
				continue
			}
			if blob, err := base64.StdEncoding.DecodeString(f[i+1]); err == nil && len(blob) > 0 {
				out = append(out, Fingerprint(blob))
			}
			break
		}
	}
	return out
}

// PinnedFingerprints reads Coolify's own host key record. It accepts a "SHA256:..." fingerprint or key lines. ok is false when the record is
// not empty but nothing in it could be read: the caller must then refuse (a pin that cannot be checked is not a pin that can be ignored).
func PinnedFingerprints(raw string) (fps []string, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, true
	}
	for _, tok := range strings.Fields(raw) {
		if strings.HasPrefix(tok, "SHA256:") && len(tok) == 7+43 {
			fps = append(fps, tok)
		}
	}
	fps = append(fps, KeyFingerprintsFromLines(raw)...)
	return fps, len(fps) > 0
}

// PreferredFingerprint picks the fingerprint to record out of those a scan returned: the ed25519 key when there is one, else the first.
func PreferredFingerprint(scanText string) string {
	var first string
	for _, line := range strings.Split(scanText, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fps := KeyFingerprintsFromLines(line)
		if len(fps) == 0 {
			continue
		}
		if first == "" {
			first = fps[0]
		}
		if strings.Contains(line, "ssh-ed25519") {
			return fps[0]
		}
	}
	return first
}

func contains(set []string, v string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

// CheckHostKey applies the pin and the hub's expectation to what a scan saw, before anything is sent to the target.
//   - Coolify pinned a key: one scanned key must match it, else hostkey_mismatch (the server is not the one Coolify knows).
//   - the hub saw a key at the probe: one scanned key must match it, else hostkey_changed (the server's key moved between probe and install).
//
// It returns the fingerprint to record: the preferred scanned one, or the pinned/expected one that matched.
func CheckHostKey(scanText, pinnedRaw, expectedFp string) (fp string, pinned bool, err error) {
	scanned := KeyFingerprintsFromLines(scanText)
	if len(scanned) == 0 {
		return "", false, fail("unreachable", "no host key offered")
	}
	pins, ok := PinnedFingerprints(pinnedRaw)
	if !ok {
		return "", false, fail("bad_target", "Coolify's host key record is unreadable")
	}
	matched := ""
	if len(pins) > 0 {
		for _, f := range scanned {
			if contains(pins, f) {
				matched = f
				break
			}
		}
		if matched == "" {
			return "", true, fail("hostkey_mismatch", "host key differs from the one Coolify pinned")
		}
		pinned = true
	}
	if expectedFp != "" {
		if !contains(scanned, expectedFp) {
			return "", pinned, fail("hostkey_changed", "host key differs from the one seen at the probe")
		}
		// The key the hub expects must also be one Coolify pinned, when Coolify pinned anything: the two checks bind the same key.
		if len(pins) > 0 && !contains(pins, expectedFp) {
			return "", true, fail("hostkey_mismatch", "host key differs from the one Coolify pinned")
		}
		matched = expectedFp
	}
	if matched == "" {
		matched = PreferredFingerprint(scanText)
	}
	return matched, pinned, nil
}

var knownHostLineRe = regexp.MustCompile(`^[a-z0-9]{6,64} (ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa) [A-Za-z0-9+/]{16,1000}={0,2}$`)

// KnownHostLine builds the one known_hosts line the ssh helper trusts: the scanned key whose fingerprint is fp (the key CheckHostKey
// verified), under the HostKeyAlias. The ssh connection is then pinned to exactly that key (StrictHostKeyChecking=yes), so a server that
// shows another key on the second connection is refused by ssh itself, before anything is sent.
func KnownHostLine(scanText, fp, alias string) (string, error) {
	for _, line := range strings.Split(scanText, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(line)
		for i := 0; i+1 < len(f); i++ {
			if !isKeyType(f[i]) {
				continue
			}
			blob, err := base64.StdEncoding.DecodeString(f[i+1])
			if err != nil || len(blob) == 0 || Fingerprint(blob) != fp {
				break
			}
			out := alias + " " + f[i] + " " + f[i+1]
			if !knownHostLineRe.MatchString(out) {
				return "", fail("unreachable", "host key type is not accepted")
			}
			return out, nil
		}
	}
	return "", fail("hostkey_changed", "verified host key not found in the scan")
}
