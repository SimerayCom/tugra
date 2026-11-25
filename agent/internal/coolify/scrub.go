package coolify

import "strings"

// scrubber removes the values the agent handled from any text before it is logged or returned. It holds the app key (every form it is
// written in) and any other string registered with add. The wire carries only fixed codes, so this is the second line: it applies to
// the little free text that exists (the helper's stderr, a docker error), never to a record.
type scrubber struct {
	needles []string
}

const redacted = "[redacted]"

// add registers a value. Very short values are ignored (they would blank out ordinary words).
func (s *scrubber) add(v string) {
	v = strings.TrimSpace(v)
	if len(v) < 6 {
		return
	}
	s.needles = append(s.needles, v)
	if rest, ok := strings.CutPrefix(v, "base64:"); ok && len(rest) >= 6 {
		s.needles = append(s.needles, rest)
	}
}

// clean returns text with every registered value replaced, and cut to max bytes.
func (s *scrubber) clean(text string, max int) string {
	for _, n := range s.needles {
		text = strings.ReplaceAll(text, n, redacted)
	}
	if max > 0 && len(text) > max {
		text = text[:max]
	}
	return text
}
