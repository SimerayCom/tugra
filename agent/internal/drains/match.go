package drains

import (
	"path"
	"strings"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// matcher decides which containers feed one drain. The hub resolves WHAT an app's containers are; the agent only
// evaluates the resolved selector, so no user-supplied glob or arbitrary name ever reaches an app-scoped filter.
type matcher struct {
	scopeApp bool
	m        *protocol.DrainMatch
}

func matchEmpty(m *protocol.DrainMatch) bool {
	return m == nil || (len(m.Names) == 0 && len(m.Prefixes) == 0 && len(m.SvcPrefixes) == 0 && len(m.Globs) == 0)
}

// compileMatcher builds the matcher for a drain. FAIL CLOSED for scope "app": a missing or empty Match selects
// NOTHING (an app drain must never fall back to "every container on the host"). A server-wide drain (scope ""
// or "server") with no Match keeps today's behaviour: every tugra_ container.
func compileMatcher(cfg protocol.DrainCfg) matcher {
	return matcher{scopeApp: cfg.Scope == "app", m: cfg.Match}
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// allows mirrors resolveAppMatch's semantics in the hub exactly: a container matches iff its name is in names OR
// starts with any prefix OR (starts with a service prefix AND the remainder is 1+ ASCII digits, so compose
// service "web" never swallows "web-2") OR path.Match matches any glob.
func (m matcher) allows(container string) bool {
	if matchEmpty(m.m) {
		return !m.scopeApp
	}
	for _, n := range m.m.Names {
		if container == n {
			return true
		}
	}
	for _, p := range m.m.Prefixes {
		if p != "" && strings.HasPrefix(container, p) {
			return true
		}
	}
	for _, p := range m.m.SvcPrefixes {
		if p != "" && strings.HasPrefix(container, p) && allDigits(container[len(p):]) {
			return true
		}
	}
	for _, g := range m.m.Globs {
		if ok, err := path.Match(g, container); err == nil && ok {
			return true
		}
	}
	return false
}
