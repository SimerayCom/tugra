package endpoints

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

const pinA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func urls(es []Endpoint) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.URL)
	}
	return out
}

func TestOrderStartsAsBootstrapOnly(t *testing.T) {
	m, err := Open("", Endpoint{URL: "wss://hub.example.com/agent"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got := urls(m.Order()); len(got) != 1 || got[0] != "wss://hub.example.com/agent" {
		t.Fatalf("initial order = %v", got)
	}
	if m.Primary().URL != "wss://hub.example.com/agent" {
		t.Fatal("the bootstrap endpoint is the primary until the hub says otherwise")
	}
}

func TestApplyOrdersPrimaryThenFallbacksThenBootstrap(t *testing.T) {
	m, _ := Open("", Endpoint{URL: "wss://old.example.com/agent"}, false)
	changed, err := m.Apply(10, []Endpoint{{URL: "wss://new.example.com/agent"}, {URL: "wss://203.0.113.7/agent", Pin: pinA}})
	if err != nil || !changed {
		t.Fatalf("Apply = %v, %v", changed, err)
	}
	want := []string{"wss://new.example.com/agent", "wss://203.0.113.7/agent", "wss://old.example.com/agent"}
	if got := urls(m.Order()); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("order = %v, want %v (the install-time address stays as the last resort)", got, want)
	}
	if m.Primary().URL != "wss://new.example.com/agent" {
		t.Fatalf("primary = %v", m.Primary())
	}
	// The same list again is a no-op (the hub re-sends it on every connect).
	if changed, err := m.Apply(11, []Endpoint{{URL: "wss://new.example.com/agent"}, {URL: "wss://203.0.113.7/agent", Pin: pinA}}); err != nil || changed {
		t.Fatalf("an identical list must not report a change: %v, %v", changed, err)
	}
}

func TestListSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "endpoints.json")
	boot := Endpoint{URL: "wss://old.example.com/agent"}
	m, _ := Open(path, boot, false)
	if _, err := m.Apply(5, []Endpoint{{URL: "wss://new.example.com/agent"}, {URL: "wss://old.example.com/agent"}}); err != nil {
		t.Fatal(err)
	}
	// "Restart": a fresh Manager on the same file, same install-time --hub.
	m2, err := Open(path, boot, false)
	if err != nil {
		t.Fatal(err)
	}
	if m2.Primary().URL != "wss://new.example.com/agent" || m2.Rev() != 5 {
		t.Fatalf("a restart lost the list: primary=%v rev=%d", m2.Primary(), m2.Rev())
	}
	if got := urls(m2.Order()); len(got) != 2 {
		t.Fatalf("order after restart = %v", got)
	}
}

func TestReinstallWithAnotherHubResetsTheList(t *testing.T) {
	path := filepath.Join(t.TempDir(), "endpoints.json")
	m, _ := Open(path, Endpoint{URL: "wss://old.example.com/agent"}, false)
	_, _ = m.Apply(5, []Endpoint{{URL: "wss://new.example.com/agent"}})
	m2, _ := Open(path, Endpoint{URL: "wss://other.example.com/agent"}, false)
	if got := urls(m2.Order()); len(got) != 1 || got[0] != "wss://other.example.com/agent" || m2.Rev() != 0 {
		t.Fatalf("a different --hub must start the list over, got %v rev=%d", got, m2.Rev())
	}
}

func TestStaleRevRefused(t *testing.T) {
	m, _ := Open("", Endpoint{URL: "wss://a.example.com/agent"}, false)
	if _, err := m.Apply(10, []Endpoint{{URL: "wss://b.example.com/agent"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Apply(9, []Endpoint{{URL: "wss://evil.example.com/agent"}}); !errors.Is(err, ErrStaleRev) {
		t.Fatalf("a replayed older list must be refused, got %v", err)
	}
	if m.Primary().URL != "wss://b.example.com/agent" {
		t.Fatal("the refused list must not change anything")
	}
}

func TestValidationRefusesUnsafeLists(t *testing.T) {
	m, _ := Open("", Endpoint{URL: "wss://a.example.com/agent"}, false)
	bad := map[string][]Endpoint{
		"empty":               {},
		"plain ws downgrade":  {{URL: "ws://hub.example.com/agent"}},
		"http scheme":         {{URL: "https://hub.example.com/agent"}},
		"credentials":         {{URL: "wss://u:p@hub.example.com/agent"}},
		"no host":             {{URL: "wss:///agent"}},
		"bare ip without pin": {{URL: "wss://203.0.113.7/agent"}},
		"malformed pin":       {{URL: "wss://203.0.113.7/agent", Pin: "sha256:zz"}},
		"pin on plain ws":     {{URL: "ws://hub-api:3000/agent", Pin: pinA}},
		"garbage":             {{URL: "::nope"}},
	}
	many := make([]Endpoint, 0, MaxEndpoints+1)
	for i := 0; i <= MaxEndpoints; i++ {
		many = append(many, Endpoint{URL: "wss://h" + string(rune('a'+i)) + ".example.com/agent"})
	}
	bad["too many"] = many
	for name, list := range bad {
		if _, err := m.Apply(1, list); err == nil {
			t.Errorf("%s: list accepted", name)
		}
	}
	if m.Rev() != 0 {
		t.Fatal("a refused list must not advance the rev")
	}
}

func TestPlainWSOnlyWithOptIn(t *testing.T) {
	strict, _ := Open("", Endpoint{URL: "wss://a.example.com/agent"}, false)
	if _, err := strict.Apply(1, []Endpoint{{URL: "ws://203.0.113.7:3000/agent"}}); err == nil {
		t.Fatal("a TLS install must never be talked down to plaintext by a pushed list")
	}
	// An internal compose name is the normal single-box setup and needs no opt-in.
	if _, err := strict.Apply(2, []Endpoint{{URL: "ws://hub-api:3000/agent"}}); err != nil {
		t.Fatalf("internal ws:// refused: %v", err)
	}
	optIn, _ := Open("", Endpoint{URL: "ws://203.0.113.7:3000/agent"}, true)
	if !optIn.AllowPlain() {
		t.Fatal("opt-in must allow plain ws://")
	}
	if err := CheckURL(Endpoint{URL: "ws://203.0.113.7:3000/agent"}, false); err == nil {
		t.Fatal("a fresh plain ws:// install without the opt-in must be refused")
	}
	if err := CheckURL(Endpoint{URL: "ws://203.0.113.7:3000/agent"}, true); err != nil {
		t.Fatalf("opt-in refused: %v", err)
	}
}

func TestPinParsingAndNormalising(t *testing.T) {
	if _, err := ParsePin(pinA); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "sha256:abc", "md5:" + strings.Repeat("a", 32), strings.Repeat("g", 64)} {
		if _, err := ParsePin(bad); err == nil {
			t.Errorf("ParsePin(%q) accepted", bad)
		}
	}
	got, err := NormalizePin("AA:" + strings.Repeat("aa:", 30) + "AA")
	if err != nil || got != pinA {
		t.Fatalf("NormalizePin = %q, %v", got, err)
	}
}

// A pinned endpoint verifies the leaf certificate by fingerprint: the right pin connects, any other cert is refused
// even though the server's certificate is perfectly well-formed.
func TestPinnedTLSAcceptsOnlyTheMatchingLeaf(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer srv.Close()
	leaf := srv.Certificate().Raw
	get := func(pin string) error {
		c, err := HTTPClient(pin, nil)
		if err != nil {
			return err
		}
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
		resp, err := c.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	if err := get(Fingerprint(leaf)); err != nil {
		t.Fatalf("the matching pin must connect: %v", err)
	}
	wrong := "sha256:" + strings.Repeat("00", 32)
	err := get(wrong)
	if err == nil || !strings.Contains(err.Error(), ErrPinMismatch.Error()) {
		t.Fatalf("a different certificate must be refused with a pin mismatch, got %v", err)
	}
	// No pin = the system roots, which do not know httptest's CA.
	if err := get(""); err == nil {
		t.Fatal("without a pin the normal chain verification must apply")
	}
}

func TestTLSConfigRefusesEmptyPeerChain(t *testing.T) {
	cfg, err := TLSConfig(pinA, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := cfg.VerifyPeerCertificate(nil, nil); !errors.Is(err, ErrPinMismatch) {
		t.Fatalf("an empty chain must not pass the pin: %v", err)
	}
	if cfg.MinVersion < tls.VersionTLS12 {
		t.Fatal("TLS 1.2 minimum")
	}
}
