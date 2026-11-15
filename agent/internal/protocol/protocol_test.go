package protocol

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"reflect"
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

func TestCanonicalLogDrainsGolden(t *testing.T) {
	// Identical vector to the TS test in packages/shared (any drift rejects every log_drains_v2 frame).
	got := CanonicalLogDrains("srv1", 1731672000000, `[{"id":"d1"}]`, "logs")
	if got != "ldrn\nsrv1\n1731672000000\n[{\"id\":\"d1\"}]\nlogs" {
		t.Fatalf("CanonicalLogDrains mismatch: %q", got)
	}
	if CanonicalLogDrains("srv2", 1, "[]", "logs") == CanonicalLogDrains("srv1", 1, "[]", "logs") {
		t.Fatal("serverId must be bound into the signed bytes")
	}
}

func TestFeaturesAdvertiseLogDrains(t *testing.T) {
	want := map[string]bool{FeatureCmdJournal: false, FeatureLogDrainsV2: false, FeatureDrainSyslog: false, FeatureDrainGelf: false, FeatureDrainFluentd: false}
	for _, f := range Features {
		if _, ok := want[f]; ok {
			want[f] = true
		}
	}
	for f, ok := range want {
		if !ok {
			t.Fatalf("Features is missing %s: %v", f, Features)
		}
	}
	if FeatureLogDrainsV2 != "log_drains_v2" || FeatureDrainSyslog != "log_drain_syslog_v1" || FeatureDrainGelf != "log_drain_gelf_v1" || FeatureDrainFluentd != "log_drain_fluentd_v1" {
		t.Fatal("feature flag names must match packages/shared")
	}
}

func TestDrainCfgLegacyShapeUnchanged(t *testing.T) {
	// A legacy log_drains entry round-trips with only the four original keys (new fields are omitempty).
	b, err := json.Marshal(DrainCfg{ID: "d1", Type: "http", Endpoint: "https://x", Token: "t"})
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"id":"d1","type":"http","endpoint":"https://x","token":"t"}` {
		t.Fatalf("legacy DrainCfg JSON changed: %s", b)
	}
	var d DrainCfg
	if err := json.Unmarshal([]byte(`{"id":"d2","scope":"app","appId":"a1","match":{"svcPrefixes":["tugra_a1-web-"]},"host":"h","options":{"proto":"udp","facility":5},"egress":"public"}`), &d); err != nil {
		t.Fatal(err)
	}
	if d.Scope != "app" || d.Match == nil || d.Match.SvcPrefixes[0] != "tugra_a1-web-" || d.Options == nil || d.Options.Facility == nil || *d.Options.Facility != 5 || d.Egress != "public" {
		t.Fatalf("v2 DrainCfg decode wrong: %+v", d)
	}
}

// goldenFs2 is pinned identically in packages/shared/src/index.spec.ts. Any drift means every signed fs2_req is
// rejected by the agent.
func goldenFs2() Fs2Fields {
	return Fs2Fields{
		ReqID: "00000000-0000-4000-8000-000000000001", Op: "write", Scope: "volume", Subject: "tugra_appv_c1_data",
		Path: "dir/héllo\n.txt", Path2: "", Mode: "0644", Flags: "o", Size: 5,
		Sha256:    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
		IfMatch:   "",
		Xfer:      "/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1800000000&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
		TimeoutMs: 30000, Exp: 1800000000, Capability: "files_write",
	}
}

const goldenFs2Canonical = "fs2\n36:00000000-0000-4000-8000-000000000001\n5:write\n6:volume\n18:tugra_appv_c1_data\n15:dir/héllo\n.txt\n0:\n4:0644\n1:o\n1:5\n64:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\n0:\n87:/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1800000000&sig=BBBBBBBBBBBBBBBBBBBBBBBB\n5:30000\n10:1800000000\n11:files_write"

func TestCanonicalFs2Golden(t *testing.T) {
	if got := CanonicalFs2(goldenFs2()); got != goldenFs2Canonical {
		t.Fatalf("CanonicalFs2 mismatch:\n got %q\nwant %q", got, goldenFs2Canonical)
	}
	// The legacy builder stays pinned (the fs2 work must never touch it).
	if got := CanonicalFs("r1", "list", "tugra_appv_x_data", "sub/dir", "files"); got != "fs\nr1\nlist\ntugra_appv_x_data\nsub/dir\nfiles" {
		t.Fatalf("CanonicalFs changed: %q", got)
	}
}

func TestCanonicalFs2TamperEveryField(t *testing.T) {
	base := CanonicalFs2(goldenFs2())
	mut := []func(*Fs2Fields){
		func(f *Fs2Fields) { f.ReqID = "00000000-0000-4000-8000-000000000002" },
		func(f *Fs2Fields) { f.Op = "mkdir" },
		func(f *Fs2Fields) { f.Scope = "container" },
		func(f *Fs2Fields) { f.Subject = "tugra_appv_c1_data2" },
		func(f *Fs2Fields) { f.Path = "dir/other" },
		func(f *Fs2Fields) { f.Path2 = "x" },
		func(f *Fs2Fields) { f.Mode = "0600" },
		func(f *Fs2Fields) { f.Flags = "or" },
		func(f *Fs2Fields) { f.Size = 6 },
		func(f *Fs2Fields) { f.Sha256 = strings.Repeat("0", 64) },
		func(f *Fs2Fields) { f.IfMatch = "5-1" },
		func(f *Fs2Fields) { f.Xfer = "" },
		func(f *Fs2Fields) { f.TimeoutMs = 30001 },
		func(f *Fs2Fields) { f.Exp = 1800000001 },
		func(f *Fs2Fields) { f.Capability = "files" },
	}
	if n := reflect.TypeOf(Fs2Fields{}).NumField(); n != len(mut) {
		t.Fatalf("Fs2Fields has %d fields but %d tamper cases", n, len(mut))
	}
	for i, m := range mut {
		f := goldenFs2()
		m(&f)
		if CanonicalFs2(f) == base {
			t.Fatalf("tamper case %d left the canonical string unchanged", i)
		}
	}
}

func TestCanonicalFs2NewlineCannotForge(t *testing.T) {
	a, b, c := goldenFs2(), goldenFs2(), goldenFs2()
	a.Path, a.Path2 = "a\nb", ""
	b.Path, b.Path2 = "a", "b"
	c.Path, c.Path2 = "a\n1:b", ""
	seen := map[string]bool{CanonicalFs2(a): true, CanonicalFs2(b): true, CanonicalFs2(c): true}
	if len(seen) != 3 {
		t.Fatal("embedded newline produced a colliding canonical string")
	}
}

func TestFs2RequiredCapsMatrix(t *testing.T) {
	eq := func(a, b []string) bool { return strings.Join(a, ",") == strings.Join(b, ",") }
	cases := []struct {
		scope, op string
		want      []string
	}{
		{"volume", "stat", []string{"files"}},
		{"volume", "read", []string{"files"}},
		{"volume", "write", []string{"files", "files_write"}},
		{"volume", "mkdir", []string{"files", "files_write"}},
		{"volume", "rename", []string{"files", "files_write"}},
		{"volume", "chmod", []string{"files", "files_write"}},
		{"volume", "delete", []string{"files", "files_write"}},
		{"volume", "list", nil},
		{"container", "list", []string{"files", "terminal"}},
		{"container", "stat", []string{"files", "terminal"}},
		{"container", "read", []string{"files", "terminal"}},
		{"container", "write", []string{"files", "files_write", "terminal"}},
		{"container", "mkdir", []string{"files", "files_write", "terminal"}},
		{"container", "rename", []string{"files", "files_write", "terminal"}},
		{"container", "chmod", []string{"files", "files_write", "terminal"}},
		{"container", "delete", []string{"files", "files_write", "terminal"}},
		{"host", "read", nil},
		{"volume", "exec", nil},
	}
	for _, c := range cases {
		if got := Fs2RequiredCaps(c.scope, c.op); !eq(got, c.want) {
			t.Errorf("Fs2RequiredCaps(%s,%s) = %v, want %v", c.scope, c.op, got, c.want)
		}
	}
}

func TestFeaturesAdvertiseFs2(t *testing.T) {
	// Membership, not position: other features (cmd_journal, log drains) share the list.
	found := false
	for _, f := range Features {
		if f == FeatureFs2 {
			found = true
		}
	}
	if !found || FeatureFs2 != "fs2_v1" {
		t.Fatalf("Features must advertise fs2_v1: %v", Features)
	}
}

func TestServerMsgFs2JSONKeys(t *testing.T) {
	raw := `{"type":"fs2_req","reqId":"r","op":"write","scope":"volume","subject":"v","path":"p","path2":"q","mode":"0644","flags":"o","size":5,"sha256":"h","ifMatch":"1-2","xfer":"/x","timeoutMs":30000,"exp":1800000000,"capability":"files_write","sig":"s"}`
	var m ServerMsg
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	f := Fs2Fields{ReqID: m.ReqID, Op: m.Op, Scope: m.Scope, Subject: m.Subject, Path: m.Path, Path2: m.Path2, Mode: m.Mode,
		Flags: m.Flags, Size: m.Size, Sha256: m.Sha256, IfMatch: m.IfMatch, Xfer: m.Xfer, TimeoutMs: m.TimeoutMs, Exp: m.Exp, Capability: m.Capability}
	want := Fs2Fields{ReqID: "r", Op: "write", Scope: "volume", Subject: "v", Path: "p", Path2: "q", Mode: "0644", Flags: "o", Size: 5,
		Sha256: "h", IfMatch: "1-2", Xfer: "/x", TimeoutMs: 30000, Exp: 1800000000, Capability: "files_write"}
	if f != want {
		t.Fatalf("decoded %+v, want %+v", f, want)
	}
}

func TestFeaturesAdvertiseHubOriginEnv(t *testing.T) {
	found := false
	for _, f := range Features {
		if f == FeatureHubOriginEnv {
			found = true
		}
	}
	if !found || FeatureHubOriginEnv != "hub_origin_env_v1" {
		t.Fatalf("Features must advertise hub_origin_env_v1: %v", Features)
	}
}
