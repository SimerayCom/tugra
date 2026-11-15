package drains

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// resolveAppMatch mirrors the hub's resolveAppMatch (apps/hub-api/src/log-drains/log-drain-match.ts) so the
// shared fixture drives BOTH implementations.
func resolveAppMatch(appID string, services []string) *protocol.DrainMatch {
	p := "tugra_" + appID
	if len(services) > 0 {
		m := &protocol.DrainMatch{}
		for _, s := range services {
			m.SvcPrefixes = append(m.SvcPrefixes, p+"-"+s+"-")
		}
		return m
	}
	return &protocol.DrainMatch{Names: []string{p, p + "__rollout"}, Prefixes: []string{p + "-", p + "."}}
}

type matchFixture struct {
	Scenarios []struct {
		Name     string   `json:"name"`
		AppID    string   `json:"appId"`
		Services []string `json:"services"`
		Cases    []struct {
			Container string `json:"container"`
			Want      bool   `json:"want"`
		} `json:"cases"`
	} `json:"scenarios"`
}

func TestMatchSharedFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/match_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx matchFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Scenarios) == 0 {
		t.Fatal("fixture has no scenarios")
	}
	for _, sc := range fx.Scenarios {
		m := compileMatcher(protocol.DrainCfg{Scope: "app", Match: resolveAppMatch(sc.AppID, sc.Services)})
		for _, c := range sc.Cases {
			if got := m.allows(c.Container); got != c.Want {
				t.Errorf("%s: allows(%q) = %v, want %v", sc.Name, c.Container, got, c.Want)
			}
		}
	}
}

func TestMatchScopeSemantics(t *testing.T) {
	// scope app + no/empty match = NOTHING (fail closed)
	for _, cfg := range []protocol.DrainCfg{
		{Scope: "app"},
		{Scope: "app", Match: &protocol.DrainMatch{}},
	} {
		if compileMatcher(cfg).allows("tugra_anything") {
			t.Fatalf("an app drain without a match must forward nothing: %+v", cfg)
		}
	}
	// scope server (or legacy "") + no match = everything
	for _, scope := range []string{"", "server"} {
		if !compileMatcher(protocol.DrainCfg{Scope: scope}).allows("tugra_anything") {
			t.Fatalf("a server-wide drain without a filter forwards everything (scope %q)", scope)
		}
	}
}

func TestMatchGlobs(t *testing.T) {
	m := compileMatcher(protocol.DrainCfg{Match: &protocol.DrainMatch{Globs: []string{"tugra_db_*", "tugra_?eb-*"}}})
	for c, want := range map[string]bool{
		"tugra_db_abc": true, "tugra_web-1": true, "tugra_proxy": false, "tugra_db": false,
	} {
		if got := m.allows(c); got != want {
			t.Errorf("glob allows(%q) = %v, want %v", c, got, want)
		}
	}
	// a malformed glob never matches (and never panics)
	if compileMatcher(protocol.DrainCfg{Match: &protocol.DrainMatch{Globs: []string{"[a"}}}).allows("a") {
		t.Fatal("bad glob must not match")
	}
}

func TestAllDigits(t *testing.T) {
	for s, want := range map[string]bool{"": false, "1": true, "12": true, "2-1": false, "x": false} {
		if allDigits(s) != want {
			t.Errorf("allDigits(%q) != %v", s, want)
		}
	}
}
