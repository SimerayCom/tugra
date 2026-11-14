package protocol

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestCanonicalStrings(t *testing.T) {
	if got := CanonicalCommand("r1", "echo hi", 5000, "deploy"); got != "cmd\nr1\necho hi\n5000\ndeploy" {
		t.Fatalf("CanonicalCommand mismatch: %q", got)
	}
	// Must be byte-identical to @tugra/shared canonicalCommandCancel.
	if got := CanonicalCommandCancel("r1"); got != "ccancel\nr1" {
		t.Fatalf("CanonicalCommandCancel mismatch: %q", got)
	}
	// Must be byte-identical to @tugra/shared canonicalCommandStatus (and distinct from cancel).
	if got := CanonicalCommandStatus("r1"); got != "cstat\nr1" {
		t.Fatalf("CanonicalCommandStatus mismatch: %q", got)
	}
	// The durable flag must NOT change the signed input (an old agent ignores it and runs the same command).
	if Version != 2 {
		t.Fatalf("protocol version must stay 2 (features are additive): %d", Version)
	}
	if got := CanonicalTermStart("s1", "tugra_app1", 80, 24, "terminal"); got != "term\ns1\ntugra_app1\n80\n24\nterminal" {
		t.Fatalf("CanonicalTermStart mismatch: %q", got)
	}
	// Must be byte-identical to @tugra/shared canonicalLogStart.
	if got := CanonicalLogStart("st1", "tugra_app1", 200, true, "1h", "err", "logs"); got != "logs\nst1\ntugra_app1\n200\n1\n1h\nerr\nlogs" {
		t.Fatalf("CanonicalLogStart(follow) mismatch: %q", got)
	}
	if got := CanonicalLogStart("st1", "c", 50, false, "", "", "logs"); got != "logs\nst1\nc\n50\n0\n\n\nlogs" {
		t.Fatalf("CanonicalLogStart(no-follow) mismatch: %q", got)
	}
	// Must be byte-identical to @tugra/shared canonicalAgentUpdate (any drift → every update rejected).
	if got := CanonicalAgentUpdate("r1", "0.2.0", "ghcr.io/simeraycom/tugra-agent:0.2.0", "deadbeef", "deploy"); got != "aupd\nr1\n0.2.0\nghcr.io/simeraycom/tugra-agent:0.2.0\ndeadbeef\ndeploy" {
		t.Fatalf("CanonicalAgentUpdate mismatch: %q", got)
	}
	// Must be byte-identical to @tugra/shared canonicalFs (any drift → every fs_req rejected).
	if got := CanonicalFs("r1", "list", "tugra_appv_x_data", "sub/dir", "files"); got != "fs\nr1\nlist\ntugra_appv_x_data\nsub/dir\nfiles" {
		t.Fatalf("CanonicalFs mismatch: %q", got)
	}
}

func hubKeyB64(t *testing.T, pub ed25519.PublicKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(der)
}

func TestVerifySigRoundTripAndTamper(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	// agent parses the SPKI hub key exactly as delivered over the wire
	parsed, err := ParseHubKey(hubKeyB64(t, pub))
	if err != nil {
		t.Fatalf("ParseHubKey: %v", err)
	}

	canonical := CanonicalCommand("r1", "echo hi", 5000, "deploy")
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(canonical)))

	if !VerifySig(parsed, canonical, sig) {
		t.Fatal("expected valid signature to verify")
	}
	// tampered command must not verify against the original signature
	if VerifySig(parsed, CanonicalCommand("r1", "rm -rf /", 5000, "deploy"), sig) {
		t.Fatal("tampered command verified — signature check is broken")
	}
	// capability-relabel must not verify (anti-downgrade: bulk sig can't become deploy)
	if VerifySig(parsed, CanonicalCommand("r1", "echo hi", 5000, "bulk"), sig) {
		t.Fatal("capability-relabel verified — capability not bound to signature")
	}
	if VerifySig(parsed, canonical, "not-base64-!!") {
		t.Fatal("garbage signature verified")
	}
	if VerifySig(nil, canonical, sig) {
		t.Fatal("nil key verified (fail-closed expected)")
	}

	// agent_update: the signed image/version/sha256 must be bound — tampering any field must not verify.
	au := CanonicalAgentUpdate("u1", "0.2.0", "ghcr.io/simeraycom/tugra-agent:0.2.0", "abc123", "deploy")
	auSig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(au)))
	if !VerifySig(parsed, au, auSig) {
		t.Fatal("expected valid agent_update signature to verify")
	}
	if VerifySig(parsed, CanonicalAgentUpdate("u1", "0.2.0", "ghcr.io/evil/agent:0.2.0", "abc123", "deploy"), auSig) {
		t.Fatal("tampered image verified — image not bound to signature")
	}
	if VerifySig(parsed, CanonicalAgentUpdate("u1", "0.2.0", "ghcr.io/simeraycom/tugra-agent:0.2.0", "deadbeef", "deploy"), auSig) {
		t.Fatal("tampered sha256 verified — digest not bound to signature")
	}
}

// A measured zero (idle load, swap configured but unused) must stay on the wire; an unreported value
// (old agent / unsupported OS) must be absent so the hub stores NULL, never a fake 0.
func TestMetricsSampleLoadSwapZeroVsAbsent(t *testing.T) {
	zero, total := 0.0, 4e9
	b, err := json.Marshal(MetricsSample{SwapUsed: &zero, SwapTotal: &total, Load15: &zero})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if v, ok := m["swapUsed"]; !ok || v.(float64) != 0 {
		t.Fatalf("swapUsed=0 must be present on the wire: %s", b)
	}
	if v, ok := m["load15"]; !ok || v.(float64) != 0 {
		t.Fatalf("load15=0 must be present on the wire: %s", b)
	}
	if m["swapTotal"].(float64) != total {
		t.Fatalf("swapTotal lost: %s", b)
	}
	for _, k := range []string{"load1", "load5"} {
		if _, ok := m[k]; ok {
			t.Fatalf("%s unreported must be absent: %s", k, b)
		}
	}
	empty, _ := json.Marshal(MetricsSample{})
	for _, k := range []string{"load1", "load5", "load15", "swapUsed", "swapTotal"} {
		if strings.Contains(string(empty), `"`+k+`"`) {
			t.Fatalf("%s must be absent when unreported: %s", k, empty)
		}
	}
	var back MetricsSample
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatal(err)
	}
	if back.SwapUsed == nil || *back.SwapUsed != 0 || back.SwapTotal == nil || *back.SwapTotal != total {
		t.Fatalf("round-trip lost swap: %+v", back)
	}
}

// The traffic_metrics wire shape is a contract with the hub (packages/shared TrafficMetricsMsg): lock the
// json tags and the round-trip, including the reserved optional countries field.
func TestTrafficMetricsRoundTrip(t *testing.T) {
	in := TrafficMetrics{
		Type:      "traffic_metrics",
		Ts:        1731153600000,
		WindowSec: 60,
		Domains: []TrafficDomainStat{{
			Host: "a.example.com", Requests: 10, S2xx: 7, S3xx: 1, S4xx: 1, S5xx: 1, Bytes: 4096,
			Paths:     []TrafficPathStat{{P: "/", N: 6, B: 2048}, {P: "/api", N: 4, B: 2048}},
			Countries: []TrafficCountryStat{{C: "TR", N: 8}},
			Browsers:  []TrafficKeyCount{{K: "Chrome", N: 9}},
			OS:        []TrafficKeyCount{{K: "Windows", N: 9}},
			Devices:   []TrafficKeyCount{{K: "desktop", N: 9}},
			Referrers: []TrafficKeyCount{{K: "(direct)", N: 10}},
			Cities:    []TrafficKeyCount{{K: "Istanbul", N: 5}},
			Networks:  []TrafficKeyCount{{K: "1.2.3.0/24", N: 10}},
			Bots:      &TrafficBots{Human: 9, Bot: 1},
			Latency:   make([]int64, len(TrafficLatencyBucketsMs)+1),
		}},
	}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"type", "ts", "windowSec", "domains"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing top-level key %q: %s", k, b)
		}
	}
	d := m["domains"].([]any)[0].(map[string]any)
	for _, k := range []string{"host", "requests", "s2xx", "s3xx", "s4xx", "s5xx", "bytes", "paths", "countries",
		"browsers", "os", "devices", "referrers", "cities", "networks", "bots", "latency"} {
		if _, ok := d[k]; !ok {
			t.Fatalf("missing domain key %q: %s", k, b)
		}
	}
	p := d["paths"].([]any)[0].(map[string]any)
	for _, k := range []string{"p", "n", "b"} {
		if _, ok := p[k]; !ok {
			t.Fatalf("missing path key %q: %s", k, b)
		}
	}
	if m["type"] != "traffic_metrics" {
		t.Fatalf("type tag wrong: %s", b)
	}
	var out TrafficMetrics
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out.Ts != in.Ts || out.WindowSec != 60 || len(out.Domains) != 1 || out.Domains[0].Host != "a.example.com" ||
		out.Domains[0].Bytes != 4096 || len(out.Domains[0].Paths) != 2 || out.Domains[0].Paths[1].P != "/api" ||
		out.Domains[0].Countries[0].C != "TR" {
		t.Fatalf("round-trip mismatch: %+v", out)
	}
	od := out.Domains[0]
	if od.Browsers[0].K != "Chrome" || od.Networks[0].K != "1.2.3.0/24" || od.Bots == nil || od.Bots.Bot != 1 || len(od.Latency) != 14 {
		t.Fatalf("round-trip lost the extended dimensions: %+v", od)
	}
	bk := d["bots"].(map[string]any)
	if _, ok := bk["human"]; !ok {
		t.Fatalf("bots tag wrong: %s", b)
	}
	if _, ok := d["unique"]; ok {
		t.Fatalf("reserved unique must be omitted while empty: %s", b)
	}
	if len(TrafficLatencyBucketsMs) != 13 || TrafficLatencyBucketsMs[12] != 10000 {
		t.Fatalf("latency bucket constant drifted from packages/shared")
	}
	// countries is optional: omitted when empty, so the wire shape matches `countries?` in the shared type.
	e, _ := json.Marshal(TrafficDomainStat{Host: "x", Paths: []TrafficPathStat{}})
	for _, k := range []string{"countries", "browsers", "os", "devices", "referrers", "cities", "networks", "bots", "latency", "unique"} {
		if strings.Contains(string(e), `"`+k+`"`) {
			t.Fatalf("empty %s must be omitted: %s", k, e)
		}
	}
}
