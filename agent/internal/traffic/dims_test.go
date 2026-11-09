package traffic

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	uaChromeWin  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	uaFirefoxLin = "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0"
	uaSafariIOS  = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1"
	uaIPad       = "Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1"
	uaGooglebot  = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
	uaEdgeWin    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"
)

// fullLine builds an access-log line carrying the two kept headers (Traefik's flat request_<Header> shape)
// and a Duration in nanoseconds.
func fullLine(ip, host, path, ua, ref string, durNs int64) string {
	return fmt.Sprintf(`{"ClientHost":%q,"RequestHost":%q,"RequestPath":%q,"DownstreamStatus":200,"DownstreamContentSize":10,"Duration":%d,"RouterName":"r@docker","request_User-Agent":%q,"request_Referer":%q}`+"\n",
		ip, host, path, durNs, ua, ref)
}

func TestClassifyUA(t *testing.T) {
	cases := []struct {
		ua                  string
		browser, os, device string
		bot                 bool
	}{
		{uaChromeWin, "Chrome", "Windows", "desktop", false},
		{uaFirefoxLin, "Firefox", "Linux", "desktop", false},
		{uaSafariIOS, "Safari", "iOS", "mobile", false},
		{uaIPad, "Safari", "iOS", "tablet", false},
		{uaEdgeWin, "Edge", "Windows", "desktop", false},
		{uaGooglebot, "Googlebot", "Other", "bot", true},
	}
	for _, c := range cases {
		b, o, d, bot := classifyUA(c.ua)
		if b != c.browser || o != c.os || d != c.device || bot != c.bot {
			t.Errorf("classifyUA(%.40q) = %q %q %q %v, want %q %q %q %v", c.ua, b, o, d, bot, c.browser, c.os, c.device, c.bot)
		}
	}
	// A bot the whitelist does not know: still a bot, name folded to "Other", the UA text never echoed.
	b, _, d, bot := classifyUA("SecretToken123-Crawler/1.0 (+https://evil.example/botinfo)")
	if !bot || d != "bot" || b != "Other" {
		t.Fatalf("unknown bot -> %q %q %v", b, d, bot)
	}
	// The parser echoes the raw UA as the browser name for unknown clients: it must be folded.
	b, o, d, bot := classifyUA("MyWeirdClient-SECRETABC")
	if b != "Other" || o != "Other" || strings.Contains(b+o+d, "SECRET") {
		t.Fatalf("unknown UA leaked: %q %q %q", b, o, d)
	}
	_ = bot
	// Bounded input: a huge junk UA does not blow up or leak.
	classifyUA(strings.Repeat("A/1 ", 100000))
}

func TestRefererHost(t *testing.T) {
	cases := []struct{ ref, reqHost, want string }{
		{"https://Google.com/search?q=secret-term&token=abc#frag", "a.com", "google.com"},
		{"https://news.example.org:8443/a/b?c=d", "a.com", "news.example.org"},
		{"https://user:pw@evil.example/x", "a.com", "evil.example"},
		{"", "a.com", refDirect},
		{"-", "a.com", refDirect},
		{"   ", "a.com", refDirect},
		{"not a url", "a.com", refDirect},
		{"https://a.com/page?x=1", "a.com", refDirect},
		{"https://www.a.com/", "a.com", refDirect},
		{"https://a.com/", "www.a.com", refDirect},
		{"https://203.0.113.9/x", "a.com", ipLiteral},
		{"android-app://com.google.android.gm/", "a.com", "com.google.android.gm"},
	}
	for _, c := range cases {
		if got := refererHost(c.ref, c.reqHost); got != c.want {
			t.Errorf("refererHost(%q,%q)=%q want %q", c.ref, c.reqHost, got, c.want)
		}
	}
	for _, in := range []string{"https://Google.com/search?q=secret-term", "https://u:pw@evil.example/x"} {
		got := refererHost(in, "a.com")
		for _, bad := range []string{"secret", "search", "pw", "https", "/", "?"} {
			if strings.Contains(got, bad) {
				t.Errorf("refererHost(%q)=%q leaks %q", in, got, bad)
			}
		}
	}
}

func TestAnonymizeNetwork(t *testing.T) {
	cases := map[string]string{
		"81.2.69.10":                "81.2.69.0/24",
		"81.2.69.10:51234":          "81.2.69.0/24",
		"::ffff:81.2.69.200":        "81.2.69.0/24",
		"2001:db8:1234:5678::1":     "2001:db8:1234::/48",
		"[2001:db8:1234:5678::1]:9": "2001:db8:1234::/48",
		"10.1.2.3":                  "", // private
		"127.0.0.1":                 "",
		"::1":                       "",
		"fe80::1":                   "",
		"garbage":                   "",
		"":                          "",
	}
	for in, want := range cases {
		got := anonymizeNetwork(in)
		if got != want {
			t.Errorf("anonymizeNetwork(%q)=%q want %q", in, got, want)
		}
		// Never a full address: the host part is always zeroed.
		if got != "" && (strings.Contains(got, ".10/") || strings.Contains(got, ".200/") || strings.Contains(got, "5678")) {
			t.Errorf("anonymizeNetwork(%q)=%q keeps host bits", in, got)
		}
	}
}

func TestLatencyBucketAndNsToMs(t *testing.T) {
	if len(protocol.TrafficLatencyBucketsMs) != 13 {
		t.Fatalf("bounds=%d", len(protocol.TrafficLatencyBucketsMs))
	}
	cases := []struct {
		ns   float64
		want int
	}{
		{0, 0},
		{500_000, 0},         // 0.5 ms
		{1_000_000, 0},       // 1 ms (inclusive bound)
		{1_000_001, 1},       // just over 1 ms
		{3_000_000, 2},       // 3 ms -> <=5
		{10_000_000, 3},      // 10 ms
		{99_000_000, 6},      // 99 ms -> <=100
		{1_000_000_000, 9},   // 1 s
		{10_000_000_000, 12}, // 10 s (last bound)
		{10_000_000_001, 13}, // overflow
		{9e15, 13},
	}
	for _, c := range cases {
		if got := latencyBucket(c.ns); got != c.want {
			t.Errorf("latencyBucket(%v)=%d want %d", c.ns, got, c.want)
		}
	}
	a := newAggregator(time.Now())
	for _, ns := range []float64{500_000, 3_000_000, 3_500_000, 20_000_000_000} {
		a.addFull("a.com", "/", 200, 1, "", false, dims{hasLat: true, lat: latencyBucket(ns)})
	}
	a.addFull("a.com", "/", 200, 1, "", false, dims{}) // no duration: not counted in the histogram
	d := a.flush(time.Now()).Domains[0]
	if len(d.Latency) != 14 || d.Latency[0] != 1 || d.Latency[2] != 2 || d.Latency[13] != 1 || d.Requests != 5 {
		t.Fatalf("latency=%v requests=%d", d.Latency, d.Requests)
	}
	var sum int64
	for _, n := range d.Latency {
		sum += n
	}
	if sum != 4 {
		t.Fatalf("histogram total=%d want 4", sum)
	}
}

func TestParseLineDimensions(t *testing.T) {
	rec, ok := parseLine([]byte(fullLine("81.2.69.10", "Shop.Example.com", "/", uaChromeWin, "https://google.com/search?q=x", 3_000_000)))
	if !ok || !rec.hasUA || rec.browser != "Chrome" || rec.os != "Windows" || rec.device != "desktop" || rec.bot ||
		rec.referrer != "google.com" || !rec.hasLat || rec.lat != 2 {
		t.Fatalf("rec=%+v ok=%v", rec, ok)
	}
	// Nested "request" object shape is accepted too.
	rec, ok = parseLine([]byte(`{"RequestHost":"a.com","RouterName":"r@docker","Duration":2000000,"request":{"User-Agent":"` + uaFirefoxLin + `","Referer":"https://dev.to/x"}}`))
	if !ok || rec.browser != "Firefox" || rec.referrer != "dev.to" || !rec.hasLat {
		t.Fatalf("nested rec=%+v ok=%v", rec, ok)
	}
	// Missing / wrong-typed fields are fine.
	rec, ok = parseLine([]byte(`{"RequestHost":"a.com","RouterName":"r@docker","Duration":"x","request_User-Agent":5}`))
	if !ok || rec.hasUA || rec.hasLat || rec.referrer != refDirect {
		t.Fatalf("degraded rec=%+v ok=%v", rec, ok)
	}
}

func TestCityLookupCountryOnlyDBYieldsNoCity(t *testing.T) {
	t.Setenv(geoIPEnv, filepath.Join("testdata", "country.mmdb"))
	g := loadGeo()
	if g == nil {
		t.Fatal("fixture should load")
	}
	defer g.close()
	cc, city := g.lookup("81.2.69.10", true)
	if cc != "GB" || city != "" {
		t.Fatalf("country-only DB: cc=%q city=%q", cc, city)
	}
	var nilGeo *geo
	if cc, city := nilGeo.lookup("81.2.69.10", true); cc != "" || city != "" {
		t.Fatal("nil geo must be empty")
	}
}

func TestCityLookupWithCityDB(t *testing.T) {
	t.Setenv(geoIPEnv, filepath.Join("testdata", "city.mmdb"))
	g := loadGeo()
	if g == nil {
		t.Fatal("city fixture should load")
	}
	defer g.close()
	if cc, city := g.lookup("81.2.69.10", true); cc != "GB" || city != "London" {
		t.Fatalf("cc=%q city=%q", cc, city)
	}
	if cc, city := g.lookup("81.2.69.10", false); cc != "GB" || city != "" {
		t.Fatalf("city must not be decoded when not wanted: cc=%q city=%q", cc, city)
	}
	if cc, city := g.lookup("10.0.0.1", true); cc != "" || city != "" {
		t.Fatal("private address must be empty")
	}
}

func TestIPModeFromEnv(t *testing.T) {
	// Fail closed: only unset/empty/"anonymized" keep the IP-derived dimensions on; every other value is off.
	for in, want := range map[string]string{
		"": ipModeAnonymized, "anonymized": ipModeAnonymized, " Anonymized ": ipModeAnonymized,
		"off": ipModeOff, " OFF ": ipModeOff,
		"full": ipModeOff, "garbage": ipModeOff, "none": ipModeOff, "disabled": ipModeOff, "false": ipModeOff,
		"0": ipModeOff, "no": ipModeOff, "of": ipModeOff,
	} {
		if got := ipModeFromEnv(in); got != want {
			t.Errorf("ipModeFromEnv(%q)=%q want %q", in, got, want)
		}
	}
}

func TestLoadIPModeEnvThenFile(t *testing.T) {
	f := filepath.Join(t.TempDir(), "mode")
	t.Setenv(ipModeEnv, "")
	if got := loadIPMode(f); got != ipModeAnonymized { // no env, no file: default
		t.Fatalf("default=%q", got)
	}
	if err := os.WriteFile(f, []byte("off\nignored\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadIPMode(f); got != ipModeOff {
		t.Fatalf("file off=%q", got)
	}
	if err := os.WriteFile(f, []byte("nope\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadIPMode(f); got != ipModeOff { // unrecognised file value fails closed
		t.Fatalf("file garbage=%q", got)
	}
	t.Setenv(ipModeEnv, "anonymized") // env wins over the file
	if got := loadIPMode(f); got != ipModeAnonymized {
		t.Fatalf("env wins=%q", got)
	}
	t.Setenv(ipModeEnv, "disabled")
	if got := loadIPMode(f); got != ipModeOff {
		t.Fatalf("env garbage=%q", got)
	}
}

func TestAnonymizeNetwork6to4NeverLeaksEmbeddedIPv4(t *testing.T) {
	// 2002:5102:450a:: embeds 81.2.69.10: only its /24 may come out, never the /48 that holds the full address.
	for _, in := range []string{"2002:5102:450a::1", "2002:5102:450a:1:2:3:4:5", "[2002:5102:450a::1]:443"} {
		got := anonymizeNetwork(in)
		if got != "81.2.69.0/24" {
			t.Errorf("anonymizeNetwork(%q)=%q want 81.2.69.0/24", in, got)
		}
		if strings.Contains(got, "5102:450a") || strings.Contains(got, "81.2.69.10") {
			t.Errorf("full embedded IPv4 leaked: %q", got)
		}
	}
	// A 6to4 address embedding a private IPv4 is not public.
	if got := anonymizeNetwork("2002:0a00:0001::1"); got != "" {
		t.Errorf("6to4 with private v4 = %q", got)
	}
	// NAT64 and Teredo keep the client address in the low bits, which the /48 mask removes (Teredo bits 32-47
	// are the relay server, not the client).
	for in, want := range map[string]string{"64:ff9b::5102:450a": "64:ff9b::/48", "2001:0:4136:e378:8000:63bf:3fff:fdd2": "2001:0:4136::/48"} {
		if got := anonymizeNetwork(in); got != want {
			t.Errorf("anonymizeNetwork(%q)=%q want %q", in, got, want)
		}
	}
}

func TestClassifyUAToolsAndScannersAreBots(t *testing.T) {
	for _, ua := range []string{
		"curl/8.4.0", "Wget/1.21", "python-requests/2.31.0", "Go-http-client/1.1", "Go-http-client/2.0", "Java/17.0.2",
		"okhttp/4.12.0", "axios/1.6.0", "node-fetch/1.0", "PostmanRuntime/7.36.0", "libwww-perl/6.67",
		"Apache-HttpClient/4.5.14 (Java/17)", "Uptime-Kuma/1.23.8", "kube-probe/1.28", "Mozilla/5.0 (compatible; Nmap Scripting Engine)",
		"Mozilla/5.0 zgrab/0.x", "Nuclei - Open-source project (github.com/projectdiscovery/nuclei)", "masscan/1.3", "sqlmap/1.7", "Nmap", "",
	} {
		_, _, d, bot := classifyUA(ua)
		if !bot || d != "bot" {
			t.Errorf("classifyUA(%q) bot=%v device=%q, want bot", ua, bot, d)
		}
	}
	for _, ua := range []string{uaChromeWin, uaFirefoxLin, uaSafariIOS, uaIPad, uaEdgeWin, "Opera/9.80 (Windows NT 6.1; U; en) Presto/2.9.168 Version/11.50"} {
		if _, _, d, bot := classifyUA(ua); bot || d == "bot" {
			t.Errorf("classifyUA(%.40q) must stay human, got bot=%v device=%q", ua, bot, d)
		}
	}
}

func collectOnce(t *testing.T, mode string, lines string) *protocol.TrafficMetrics {
	t.Helper()
	t.Setenv(geoIPEnv, filepath.Join("testdata", "city.mmdb"))
	if mode != "" {
		t.Setenv(ipModeEnv, mode)
	}
	p := filepath.Join(t.TempDir(), "access.json")
	appendFile(t, p, "")
	c := newCollector(p, loadGeo(), time.Now())
	t.Cleanup(c.Close)
	appendFile(t, p, lines)
	c.ingestNew()
	return c.flushAt(time.Now())
}

func keyMap(kc []protocol.TrafficKeyCount) map[string]int64 {
	m := map[string]int64{}
	for _, x := range kc {
		m[x.K] = x.N
	}
	return m
}

func TestCollectorDimensionsAnonymizedDefault(t *testing.T) {
	m := collectOnce(t, "", fullLine("81.2.69.10", "a.com", "/", uaChromeWin, "https://google.com/s?q=1", 2_000_000)+
		fullLine("81.2.69.77", "a.com", "/", uaSafariIOS, "", 30_000_000)+
		fullLine("89.160.20.9", "a.com", "/x", uaGooglebot, "https://a.com/", 400_000_000))
	if m == nil || len(m.Domains) != 1 {
		t.Fatalf("m=%+v", m)
	}
	d := m.Domains[0]
	if got := keyMap(d.Browsers); got["Chrome"] != 1 || got["Safari"] != 1 || got["Googlebot"] != 1 {
		t.Fatalf("browsers=%v", d.Browsers)
	}
	if got := keyMap(d.OS); got["Windows"] != 1 || got["iOS"] != 1 {
		t.Fatalf("os=%v", d.OS)
	}
	if got := keyMap(d.Devices); got["desktop"] != 1 || got["mobile"] != 1 || got["bot"] != 1 {
		t.Fatalf("devices=%v", d.Devices)
	}
	if d.Bots == nil || d.Bots.Human != 2 || d.Bots.Bot != 1 {
		t.Fatalf("bots=%+v", d.Bots)
	}
	if got := keyMap(d.Referrers); got["google.com"] != 1 || got[refDirect] != 2 {
		t.Fatalf("referrers=%v", d.Referrers)
	}
	if got := keyMap(d.Cities); got["London"] != 2 || got["Linkoping"] != 1 {
		t.Fatalf("cities=%v", d.Cities)
	}
	if got := keyMap(d.Networks); got["81.2.69.0/24"] != 2 || got["89.160.20.0/24"] != 1 {
		t.Fatalf("networks=%v", d.Networks)
	}
	if len(d.Latency) != 14 || d.Unique != "" {
		t.Fatalf("latency=%v unique=%q", d.Latency, d.Unique)
	}
	if len(d.Countries) != 2 || d.Countries[0].C != "GB" || d.Countries[0].N != 2 || d.Countries[1].C != "SE" {
		t.Fatalf("countries=%v", d.Countries)
	}
}

func TestCollectorIPModeOffDropsNetworkAndCity(t *testing.T) {
	m := collectOnce(t, "off", fullLine("81.2.69.10", "a.com", "/", uaChromeWin, "", 2_000_000))
	d := m.Domains[0]
	if len(d.Networks) != 0 || len(d.Cities) != 0 {
		t.Fatalf("off mode must emit no network/city: %+v %+v", d.Networks, d.Cities)
	}
	if len(d.Countries) != 1 || d.Countries[0].C != "GB" { // country is unaffected
		t.Fatalf("country must still work: %+v", d.Countries)
	}
	if len(d.Browsers) != 1 {
		t.Fatalf("browser dimension unaffected: %+v", d.Browsers)
	}
	b, _ := json.Marshal(m)
	for _, k := range []string{`"networks"`, `"cities"`, "81.2.69"} {
		if strings.Contains(string(b), k) {
			t.Fatalf("off mode leaks %s: %s", k, b)
		}
	}
}

func TestDimensionCapsAndOtherFold(t *testing.T) {
	a := newAggregator(time.Now())
	// 80 distinct referrers: top maxDimSent kept, the tail folds into (other).
	for i := 0; i < 80; i++ {
		for j := 0; j <= 80-i; j++ {
			a.addFull("a.com", "/", 200, 1, "", false, dims{referrer: fmt.Sprintf("r%02d.example", i)})
		}
	}
	a.addFull("a.com", "/", 200, 1, "", false, dims{referrer: otherDim}) // literal (other) merges, not duplicates
	d := a.flush(time.Now()).Domains[0]
	if len(d.Referrers) != maxDimSent+1 {
		t.Fatalf("referrers=%d", len(d.Referrers))
	}
	last := d.Referrers[len(d.Referrers)-1]
	if last.K != otherDim || last.N < 2 {
		t.Fatalf("last=%+v", last)
	}
	var sum int64
	for _, r := range d.Referrers {
		sum += r.N
	}
	if sum != d.Requests {
		t.Fatalf("referrer total %d != requests %d", sum, d.Requests)
	}

	// Tracked-key bound: a flood of distinct values folds into (other), memory stays bounded, totals reconcile.
	a = newAggregator(time.Now())
	n := maxDimKeys * 3
	for i := 0; i < n; i++ {
		a.addFull("a.com", "/", 200, 1, "", false, dims{network: fmt.Sprintf("10.%d.%d.0/24", i/256, i%256)})
	}
	if got := len(a.domains["a.com"].networks); got > maxDimKeys+1 {
		t.Fatalf("tracked network keys=%d exceeds bound", got)
	}
	d = a.flush(time.Now()).Domains[0]
	sum = 0
	for _, r := range d.Networks {
		sum += r.N
	}
	if sum != int64(n) || d.Networks[len(d.Networks)-1].K != otherDim {
		t.Fatalf("sum=%d n=%d last=%+v", sum, n, d.Networks[len(d.Networks)-1])
	}
}

// Hosts folded into (other) keep their dimension counts.
func TestDimensionsFoldWithOverflowHosts(t *testing.T) {
	a := newAggregator(time.Now())
	for i := 0; i < maxDomainsPerFlush+5; i++ {
		a.addFull(fmt.Sprintf("h%04d.com", i), "/", 200, 1, "", false,
			dims{hasUA: true, browser: "Chrome", os: "Windows", device: "desktop", referrer: refDirect, hasLat: true, lat: 3})
	}
	m := a.flush(time.Now())
	var other *protocol.TrafficDomainStat
	for i := range m.Domains {
		if m.Domains[i].Host == otherHost {
			other = &m.Domains[i]
		}
	}
	if other == nil || other.Requests != 5 || keyMap(other.Browsers)["Chrome"] != 5 || other.Bots == nil || other.Bots.Human != 5 || other.Latency[3] != 5 {
		t.Fatalf("other=%+v", other)
	}
}

// The core promise: the serialized message never contains the raw UA, the Referer path/query, a full
// client IP, or any field outside the allow-list.
func TestCollectorDimensionsNoRawLeak(t *testing.T) {
	const (
		uaToken   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 SECRETUATOKEN9f8e7d"
		refSecret = "https://Referrer.Example.net/private/path/42?session=SECRETREFTOKEN&email=a@b.c#frag"
	)
	lines := fullLine("81.2.69.143", "shop.example.com", "/", uaToken, refSecret, 7_000_000) +
		fullLine("2001:db8:abcd:1234::77", "shop.example.com", "/", "WeirdClient SECRETUATOKEN9f8e7d", refSecret, 9_000_000)
	for _, mode := range []string{"", "off"} {
		m := collectOnce(t, mode, lines)
		b, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		s := string(b)
		for _, forbidden := range []string{
			"SECRETUATOKEN", "WeirdClient", "AppleWebKit", "Mozilla", "KHTML", "Win64", // raw UA
			"SECRETREFTOKEN", "private", "/42", "session", "email", "frag", "https://", "a@b.c", // referer path/query/scheme
			"81.2.69.143", "2001:db8:abcd:1234", "::77", ".143", // full client IPs
			"ClientHost", "User-Agent", "Referer", "Cookie",
		} {
			if strings.Contains(s, forbidden) {
				t.Fatalf("mode %q: message leaks %q: %s", mode, forbidden, s)
			}
		}
		if !strings.Contains(s, "referrer.example.net") {
			t.Fatalf("referrer host should be kept: %s", s)
		}
		var generic map[string]any
		if err := json.Unmarshal(b, &generic); err != nil {
			t.Fatal(err)
		}
		dom := generic["domains"].([]any)[0].(map[string]any)
		allowed := map[string]bool{"host": true, "requests": true, "s2xx": true, "s3xx": true, "s4xx": true, "s5xx": true, "bytes": true,
			"paths": true, "countries": true, "browsers": true, "os": true, "devices": true, "referrers": true, "cities": true,
			"networks": true, "bots": true, "latency": true}
		for k := range dom {
			if !allowed[k] {
				t.Fatalf("unexpected domain field %q", k)
			}
		}
		if mode == "" {
			if !strings.Contains(s, "81.2.69.0/24") || !strings.Contains(s, "2001:db8:abcd::/48") {
				t.Fatalf("anonymized networks missing: %s", s)
			}
		}
	}
}

// A key that turns heavy only late in the window must still be ranked (top-N, not first-seen-wins), and
// junk-spraying distinct keys must not blind the ranking. Totals reconcile and memory stays bounded.
func TestDimensionTopNNotFirstSeen(t *testing.T) {
	a := newAggregator(time.Now())
	total := 0
	for i := 0; i < 600; i++ {
		a.addFull("a.com", "/", 200, 1, "", false, dims{referrer: fmt.Sprintf("junk%d.example", i)})
		total++
	}
	for i := 0; i < 1000; i++ {
		a.addFull("a.com", "/", 200, 1, "", false, dims{referrer: "google.com"})
		total++
	}
	if got := len(a.domains["a.com"].referrers); got > maxDimKeys+1 {
		t.Fatalf("tracked referrer keys=%d exceeds bound", got)
	}
	d := a.flush(time.Now()).Domains[0]
	if len(d.Referrers) == 0 || d.Referrers[0].K != "google.com" || d.Referrers[0].N != 1000 {
		t.Fatalf("late heavy referrer lost: %+v", d.Referrers[:min(3, len(d.Referrers))])
	}
	var sum int64
	for _, r := range d.Referrers {
		sum += r.N
	}
	if sum != int64(total) {
		t.Fatalf("referrer total %d != %d", sum, total)
	}

	// Same for paths.
	b := newAggregator(time.Now())
	for i := 0; i < maxPathKeys+400; i++ {
		b.add("a.com", fmt.Sprintf("/junk%d", i), 200, 1, "")
	}
	for i := 0; i < 500; i++ {
		b.add("a.com", "/hot", 200, 1, "")
	}
	p := b.flush(time.Now()).Domains[0]
	if len(p.Paths) == 0 || p.Paths[0].P != "/hot" || p.Paths[0].N != 500 {
		t.Fatalf("late heavy path lost: %+v", p.Paths[:min(3, len(p.Paths))])
	}
	var ps int64
	for _, x := range p.Paths {
		ps += x.N
	}
	if ps != p.Requests {
		t.Fatalf("path total %d != requests %d", ps, p.Requests)
	}
}
