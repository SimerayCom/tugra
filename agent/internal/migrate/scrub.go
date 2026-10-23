package migrate

import (
	"regexp"
	"strings"
)

// migTokenRe matches a migration token anywhere in a string (tugra_mig_ + 43 base64url
// chars). Kept in sync with MIGRATION_TOKEN_RE in apps/hub-api/src/importer/migration-token.ts.
var migTokenRe = regexp.MustCompile(`tugra_mig_[A-Za-z0-9_-]{43}`)

// scrubber redacts secrets from any human-facing string (stderr progress lines, error
// text, a tool's captured stderr tail). It ALWAYS strips the migration token, plus any
// values registered at runtime (resolved DB passwords / usernames / database names), so
// an accidental %v, a wrapped net error carrying a proxied URL, or a tool's stderr can
// never echo a credential. It never stores a secret longer than the run and is the single
// chokepoint every byte passes through before it reaches a log or the one JSON line.
type scrubber struct {
	secrets []string
}

// add registers a literal secret value to redact. Empty and very short values are ignored:
// redacting a 1-2 char value would turn ordinary log text into a wall of asterisks and
// leak nothing meaningful anyway.
func (s *scrubber) add(secret string) {
	if len(secret) >= 3 {
		s.secrets = append(s.secrets, secret)
	}
}

// scrub returns in with every known secret and any migration-token-shaped substring
// replaced. Order: token first (fixed shape), then longest registered secrets first so a
// secret that contains another is fully covered.
func (s *scrubber) scrub(in string) string {
	out := migTokenRe.ReplaceAllString(in, "tugra_mig_***")
	// Replace longer secrets first (a password may contain a username as a substring).
	ordered := make([]string, len(s.secrets))
	copy(ordered, s.secrets)
	for i := 1; i < len(ordered); i++ {
		for j := i; j > 0 && len(ordered[j]) > len(ordered[j-1]); j-- {
			ordered[j], ordered[j-1] = ordered[j-1], ordered[j]
		}
	}
	for _, sec := range ordered {
		out = strings.ReplaceAll(out, sec, "***")
	}
	return out
}
