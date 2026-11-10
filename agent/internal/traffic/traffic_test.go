package traffic

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func appendFile(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

func logLine(ip, host, path string, status, size int, router string) string {
	return fmt.Sprintf(`{"ClientHost":%q,"RequestHost":%q,"RequestPath":%q,"RequestMethod":"GET","DownstreamStatus":%d,"DownstreamContentSize":%d,"Duration":1000,"StartUTC":"2026-01-01T00:00:00Z","RouterName":%q,"EntryPointName":"websecure"}`+"\n",
		ip, host, path, status, size, router)
}

func strs(lines [][]byte) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = string(l)
	}
	return out
}

func TestTailerMissingFileIsIdle(t *testing.T) {
	tl := newTailer(filepath.Join(t.TempDir(), "access.json"))
	for i := 0; i < 3; i++ {
		if got := tl.readLines(); len(got) != 0 {
			t.Fatalf("missing file yielded %v", got)
		}
	}
}

func TestTailerReadsAppendedLinesAndBuffersPartial(t *testing.T) {
	p := filepath.Join(t.TempDir(), "access.json")
	appendFile(t, p, "old1\nold2\n")
	tl := newTailer(p)
	if got := tl.readLines(); len(got) != 0 {
		t.Fatalf("existing history must be skipped, got %v", got)
	}
	appendFile(t, p, "a\nb\npart")
	if got := strs(tl.readLines()); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("got %v", got)
	}
	if got := tl.readLines(); len(got) != 0 {
		t.Fatalf("nothing new, got %v", got)
	}
	appendFile(t, p, "ial\nc\r\n\n")
	if got := strs(tl.readLines()); len(got) != 2 || got[0] != "partial" || got[1] != "c" {
		t.Fatalf("got %v", got)
	}
}

func TestTailerResetsOnCopytruncate(t *testing.T) {
	p := filepath.Join(t.TempDir(), "access.json")
	appendFile(t, p, "")
	tl := newTailer(p)
	appendFile(t, p, "one\ntwo\nthree\n")
	if got := tl.readLines(); len(got) != 3 {
		t.Fatalf("got %v", strs(got))
	}
	if err := os.Truncate(p, 0); err != nil { // same inode, size back to 0
		t.Fatal(err)
	}
	if got := tl.readLines(); len(got) != 0 {
		t.Fatalf("got %v", strs(got))
	}
	appendFile(t, p, "x\n")
	if got := strs(tl.readLines()); len(got) != 1 || got[0] != "x" {
		t.Fatalf("after truncate got %v", got)
	}
}

func TestTailerFileAppearsLaterReadFromStart(t *testing.T) {
	p := filepath.Join(t.TempDir(), "access.json")
	tl := newTailer(p)
	tl.readLines() // missing
	appendFile(t, p, "first\n")
	if got := strs(tl.readLines()); len(got) != 1 || got[0] != "first" {
		t.Fatalf("got %v", got)
	}
}

func TestTailerFloodIsBounded(t *testing.T) {
	p := filepath.Join(t.TempDir(), "access.json")
	appendFile(t, p, "")
	tl := newTailer(p)
	tl.maxBytes = 64
	tl.maxLines = 3
	appendFile(t, p, strings.Repeat("line-of-text\n", 100))
	got := tl.readLines()
	if len(got) > 3 {
		t.Fatalf("line cap exceeded: %d", len(got))
	}
	for _, l := range got {
		if string(l) != "line-of-text" {
			t.Fatalf("misaligned line %q", l)
		}
	}
	if tl.dropped == 0 {
		t.Fatal("expected overflow to be counted")
	}
}

func TestTailerStreamsBeyondOldCap(t *testing.T) {
	p := filepath.Join(t.TempDir(), "access.json")
	appendFile(t, p, "")
	tl := newTailer(p)
	// ~1.4 MiB across many chunks: every line arrives, in order, with none dropped.
	var sb strings.Builder
	const n = 20000
	for i := 0; i < n; i++ {
		fmt.Fprintf(&sb, "line-%06d-%s\n", i, strings.Repeat("x", 50))
	}
	appendFile(t, p, sb.String())
	got := 0
	tl.forEachLine(func(l []byte) {
		want := fmt.Sprintf("line-%06d-%s", got, strings.Repeat("x", 50))
		if string(l) != want {
			t.Fatalf("line %d = %q", got, l)
		}
		got++
	})
	if got != n || tl.dropped != 0 {
		t.Fatalf("got=%d dropped=%d", got, tl.dropped)
	}
}

func TestTailerLineCapDefersInsteadOfDropping(t *testing.T) {
	p := filepath.Join(t.TempDir(), "access.json")
	appendFile(t, p, "")
	tl := newTailer(p)
	tl.maxLines = 3
	appendFile(t, p, "a\nb\nc\nd\ne\nf\ng\npart")
	var all []string
	for i := 0; i < 5; i++ {
		all = append(all, strs(tl.readLines())...)
	}
	if strings.Join(all, ",") != "a,b,c,d,e,f,g" || tl.dropped != 0 {
		t.Fatalf("all=%v dropped=%d", all, tl.dropped)
	}
	appendFile(t, p, "ial\n")
	if got := strs(tl.readLines()); len(got) != 1 || got[0] != "partial" {
		t.Fatalf("got=%v", got)
	}
}

func TestParseLineClassesAndExclusions(t *testing.T) {
	rec, ok := parseLine([]byte(logLine("203.0.113.9", "Example.COM:443.", "/a?x=1#f", 404, 12, "app-websecure@docker")))
	if !ok || rec.host != "example.com" || rec.path != "/a" || rec.status != 404 || rec.bytes != 12 {
		t.Fatalf("rec=%+v ok=%v", rec, ok)
	}
	for _, router := range []string{
		"tugra_abc-web@docker", "tugra_abc-d1a2b3c4-web@docker", "tugra_abc-web", // redirect twins (real Traefik shape carries @provider)
		"tugra-panel-redirect@file", "api@internal", "noop@internal",
	} {
		if _, ok := parseLine([]byte(logLine("1.1.1.1", "a.com", "/", 200, 1, router))); ok {
			t.Fatalf("router %q must be excluded", router)
		}
	}
	// Real-traffic routers that merely end in "-web" or sit on another provider are NOT twins.
	for _, router := range []string{"tugra-panel-web@file", "shop-web@docker", "tugra_abc@docker", "tugra_abc-websecure@docker", "tugra_abc-s1a2b3c4@docker"} {
		if _, ok := parseLine([]byte(logLine("1.1.1.1", "a.com", "/", 200, 1, router))); !ok {
			t.Fatalf("router %q must be counted", router)
		}
	}
	if r, ok := parseLine([]byte(logLine("1.1.1.1", "a.com", "/", 200, 1, ""))); !ok || !r.unrouted {
		t.Fatal("empty router (unmatched request) still counts, flagged unrouted")
	}
	for _, bad := range []string{"", "not json", "{", `{"RequestHost":5}`, `[1,2]`, `{"RequestHost":"","DownstreamStatus":200}`} {
		if _, ok := parseLine([]byte(bad)); ok {
			t.Fatalf("malformed %q must be skipped", bad)
		}
	}
	// Non-string / negative numbers degrade gracefully.
	rec, ok = parseLine([]byte(`{"RequestHost":"a.com","DownstreamStatus":"x","DownstreamContentSize":-5,"RouterName":7}`))
	if !ok || rec.status != 0 || rec.bytes != 0 || rec.path != "/" {
		t.Fatalf("rec=%+v ok=%v", rec, ok)
	}
}

func TestNormalizeHostAndPath(t *testing.T) {
	cases := map[string]string{
		"Foo.Example.com":                "foo.example.com",
		"foo.com:8080":                   "foo.com",
		"foo.com.":                       "foo.com",
		" FOO.com.:443 ":                 "foo.com",
		"[2001:db8::1]:80":               ipLiteral,
		"2001:db8::1":                    ipLiteral,
		"203.0.113.9":                    ipLiteral,
		"203.0.113.9:8080":               ipLiteral,
		"a.com?token=abc#x":              "a.com",
		"a.com/evil":                     "a.com",
		"user:pw@evil.com":               invalidHost,
		"u@evil.com":                     invalidHost,
		"a.com:80:90":                    invalidHost,
		"a.com:port":                     invalidHost,
		"a b.com":                        invalidHost,
		"a.com\n":                        "a.com",
		"x\ny.com":                       invalidHost,
		"<script>.com":                   invalidHost,
		"-a.com":                         invalidHost,
		"a..com":                         invalidHost,
		"éa.com":                         invalidHost,
		"my_host.example":                "my_host.example",
		"xn--bcher-kva.de":               "xn--bcher-kva.de",
		strings.Repeat("a", 300):         invalidHost,
		strings.Repeat("a", 64) + ".com": invalidHost,
		"":                               "",
		".":                              "",
	}
	for in, want := range cases {
		if got := normalizeHost(in); got != want {
			t.Errorf("normalizeHost(%q)=%q want %q", in, got, want)
		}
	}
	long := "/" + strings.Repeat("é", 300)
	if got := normalizePath(long); len(got) > maxPathLen || !strings.HasPrefix(got, "/é") {
		t.Fatalf("len=%d", len(got))
	}
	if normalizePath("?a=b") != "/" || normalizePath("/x#y") != "/x" {
		t.Fatal("query/fragment strip")
	}
}

func TestNormalizePathSanitises(t *testing.T) {
	cases := map[string]string{
		"/reset/TOKEN123abc?x=1#frag":                  "/reset/:id",
		"/a;jsessionid=SECRET":                         "/a",
		"/u/jane.doe@corp.com/orders":                  "/u/:id/orders",
		"/u/jane.doe%40corp.com/orders":                "/u/:id/orders",
		"/p%3Ftoken=zzz":                               "/p",
		"/p%3ftoken=zzz":                               "/p",
		"/p%23frag":                                    "/p",
		"/p%3Btoken=zzz":                               "/p",
		"/orders/12345":                                "/orders/:id",
		"/orders/12345/items/7":                        "/orders/:id/items/:id",
		"/u/123e4567-e89b-12d3-a456-426614174000":      "/u/:id",
		"/verify/0123456789abcdef0123456789abcdef":     "/verify/:id",
		"/t/eyJhbGciOiJIUzI1NiJ9":                      "/t/:id",
		"/t/Ab3dEf6hIj9kLm2nOp5qRs8":                   "/t/:id",
		"/static/chunk-5f3a9b1c2d4e6f70.js":            "/static/:id",
		"/static/jquery-3.6.0.min.js":                  "/static/jquery-3.6.0.min.js",
		"/blog/a-very-long-article-title-about-things": "/blog/a-very-long-article-title-about-things",
		"/api/v1/users":                                "/api/v1/users",
		"/shop/":                                       "/shop/",
		"":                                             "/",
		"noslash":                                      "/noslash",
		"/a%00b":                                       otherPath,
		"/a\nb":                                        otherPath,
		"/a\x7fb":                                      otherPath,
		"/a\xffb":                                      otherPath,
	}
	for in, want := range cases {
		if got := normalizePath(in); got != want {
			t.Errorf("normalizePath(%q)=%q want %q", in, got, want)
		}
	}
	for _, in := range []string{"/x?" + strings.Repeat("a", 9000), "/" + strings.Repeat("ab/", 3000)} {
		if got := normalizePath(in); len(got) > maxPathLen {
			t.Errorf("unbounded path len=%d", len(got))
		}
	}
}

func TestAggregatorWindowsCountsAndReset(t *testing.T) {
	t0 := time.UnixMilli(1_700_000_000_000)
	a := newAggregator(t0)
	a.add("a.com", "/", 200, 10, "GB")
	a.add("a.com", "/", 301, 5, "GB")
	a.add("a.com", "/x", 404, 1, "")
	a.add("a.com", "/x", 503, 1, "SE")
	a.add("b.com", "/", 200, 7, "")
	t1 := t0.Add(60 * time.Second)
	m := a.flush(t1)
	if m == nil || m.Type != "traffic_metrics" || m.Ts != t0.UnixMilli() || m.WindowSec != 60 || len(m.Domains) != 2 {
		t.Fatalf("m=%+v", m)
	}
	d := m.Domains[0]
	if d.Host != "a.com" || d.Requests != 4 || d.S2xx != 1 || d.S3xx != 1 || d.S4xx != 1 || d.S5xx != 1 || d.Bytes != 17 {
		t.Fatalf("d=%+v", d)
	}
	if len(d.Paths) != 2 || d.Paths[0].P != "/" || d.Paths[0].N != 2 || d.Paths[0].B != 15 {
		t.Fatalf("paths=%+v", d.Paths)
	}
	if len(d.Countries) != 2 || d.Countries[0].C != "GB" || d.Countries[0].N != 2 {
		t.Fatalf("countries=%+v", d.Countries)
	}
	if m.Domains[1].Countries != nil {
		t.Fatalf("b.com has no known country: %+v", m.Domains[1].Countries)
	}
	// Delta semantics: window reset, next window empty -> nil, Ts advances.
	if a.flush(t1.Add(60*time.Second)) != nil {
		t.Fatal("empty window must flush nil")
	}
	a.add("a.com", "/", 200, 1, "")
	if m2 := a.flush(t1.Add(120 * time.Second)); m2 == nil || m2.Ts != t1.Add(60*time.Second).UnixMilli() || m2.Domains[0].Requests != 1 {
		t.Fatalf("m2=%+v", m2)
	}
}

func TestAggregatorCapsAndOverflow(t *testing.T) {
	a := newAggregator(time.Now())
	// Paths: 80 distinct, p0 busiest ... fold the tail into (other).
	for i := 0; i < 80; i++ {
		for j := 0; j <= 80-i; j++ {
			a.add("a.com", fmt.Sprintf("/p%02d", i), 200, 1, "")
		}
	}
	a.add("a.com", otherPath, 200, 1, "") // literal "(other)" merges instead of duplicating
	m := a.flush(time.Now())
	d := m.Domains[0]
	if len(d.Paths) != maxPathsPerDomain+1 {
		t.Fatalf("paths=%d", len(d.Paths))
	}
	last := d.Paths[len(d.Paths)-1]
	if last.P != otherPath {
		t.Fatalf("last=%+v", last)
	}
	var sum, other int64
	for _, p := range d.Paths {
		sum += p.N
	}
	other = last.N
	if sum != d.Requests || other < 1 {
		t.Fatalf("sum=%d requests=%d other=%d", sum, d.Requests, other)
	}
	if d.Paths[0].P != "/p00" {
		t.Fatalf("top=%+v", d.Paths[0])
	}

	// Distinct-path accumulation bound.
	b := newAggregator(time.Now())
	for i := 0; i < maxPathKeys+500; i++ {
		b.add("a.com", fmt.Sprintf("/u%d", i), 200, 1, "")
	}
	if n := len(b.domains["a.com"].paths); n > maxPathKeys+1 {
		t.Fatalf("path keys=%d", n)
	}

	// Domains: more than the per-flush cap -> busiest kept.
	c := newAggregator(time.Now())
	for i := 0; i < maxDomainsPerFlush+50; i++ {
		for j := 0; j <= i; j++ {
			c.add(fmt.Sprintf("h%03d.com", i), "/", 200, 1, "")
		}
	}
	c0Total := c.total
	cm := c.flush(time.Now())
	if len(cm.Domains) != maxDomainsPerFlush+1 || cm.Domains[0].Host != fmt.Sprintf("h%03d.com", maxDomainsPerFlush+49) {
		t.Fatalf("domains=%d first=%s", len(cm.Domains), cm.Domains[0].Host)
	}
	// The 50 hosts below the cap fold into one (other) row, so the totals still reconcile.
	var sumReq int64
	for _, d := range cm.Domains {
		sumReq += d.Requests
	}
	if sumReq != c0Total {
		t.Fatalf("flushed requests %d != accepted", sumReq)
	}
	if last := cm.Domains[len(cm.Domains)-1]; last.Host != otherHost || last.Requests != 50*51/2 {
		t.Fatalf("overflow row=%+v", last)
	}

	// Countries beyond the cap fold into the overflow bucket.
	e := newAggregator(time.Now())
	for i := 0; i < maxCountries+20; i++ {
		cc := string(rune('A'+i/26)) + string(rune('A'+i%26))
		e.add("a.com", "/", 200, 1, cc)
	}
	ec := e.flush(time.Now()).Domains[0].Countries
	if len(ec) != maxCountries+1 || ec[len(ec)-1].C != otherCountry || ec[len(ec)-1].N != 20 {
		t.Fatalf("countries=%d last=%+v", len(ec), ec[len(ec)-1])
	}

	// Host-key flood is bounded; newcomers fold into (other) and known hosts keep counting.
	f := newAggregator(time.Now())
	for i := 0; i < maxHostKeys+100; i++ {
		f.add(fmt.Sprintf("x%d.com", i), "/", 200, 1, "")
	}
	f.add("x0.com", "/", 200, 1, "")
	if len(f.domains) != maxHostKeys+1 || f.domains["x0.com"].requests != 2 || f.domains[otherHost].requests != 100 {
		t.Fatalf("hosts=%d", len(f.domains))
	}

	// Router-less junk hosts cannot starve a routed app of its own row.
	g := newAggregator(time.Now())
	for i := 0; i < maxHostKeys; i++ {
		g.addRecord(fmt.Sprintf("junk%d.x", i), "/", 404, 1, "", true)
	}
	for i := 0; i < 500; i++ {
		g.addRecord("real.com", "/", 200, 1, "", false)
	}
	gm := g.flush(time.Now())
	var realReq, otherReq, total int64
	for _, d := range gm.Domains {
		total += d.Requests
		switch d.Host {
		case "real.com":
			realReq = d.Requests
		case otherHost:
			otherReq = d.Requests
		}
	}
	if realReq != 500 || otherReq != maxHostKeys-maxUnroutedKeys || total != maxHostKeys+500 {
		t.Fatalf("real=%d other=%d total=%d", realReq, otherReq, total)
	}
}

func TestGeoNoDBAndBadInput(t *testing.T) {
	var g *geo
	for _, in := range []string{"", "garbage", "8.8.8.8", "10.0.0.1", "::1"} {
		if got := g.country(in); got != "" {
			t.Fatalf("nil geo %q -> %q", in, got)
		}
	}
	if openGeo(filepath.Join(t.TempDir(), "missing.mmdb")) != nil || openGeo("") != nil {
		t.Fatal("absent DB must yield nil")
	}
	bad := filepath.Join(t.TempDir(), "bad.mmdb")
	if err := os.WriteFile(bad, []byte("not an mmdb"), 0o644); err != nil {
		t.Fatal(err)
	}
	if openGeo(bad) != nil {
		t.Fatal("corrupt DB must yield nil")
	}
	t.Setenv(geoIPEnv, filepath.Join(t.TempDir(), "nope.mmdb"))
	if loadGeo() != nil {
		t.Fatal("env path absent -> nil")
	}
}

func TestGeoLookupWithFixtureDB(t *testing.T) {
	t.Setenv(geoIPEnv, filepath.Join("testdata", "country.mmdb"))
	g := loadGeo()
	if g == nil {
		t.Fatal("fixture DB should load")
	}
	defer g.close()
	cases := map[string]string{
		"81.2.69.10":       "GB",
		"89.160.20.5:443":  "SE",
		"2a02:6b8::5":      "DE",
		"::ffff:81.2.69.1": "GB",
		"8.8.8.8":          "", // not in fixture
		"10.1.2.3":         "", // private
		"127.0.0.1":        "",
		"169.254.1.1":      "",
		"0.0.0.0":          "",
		"not-an-ip":        "",
		"":                 "",
	}
	for in, want := range cases {
		if got := g.country(in); got != want {
			t.Errorf("country(%q)=%q want %q", in, got, want)
		}
	}
}

func TestCollectorEndToEndNoIPLeak(t *testing.T) {
	t.Setenv(geoIPEnv, filepath.Join("testdata", "country.mmdb"))
	p := filepath.Join(t.TempDir(), "access.json")
	appendFile(t, p, "")
	c := newCollector(p, loadGeo(), time.Now())
	defer c.Close()

	appendFile(t, p,
		logLine("81.2.69.10", "Shop.Example.com:443", "/cart?token=secret", 200, 100, "shop-websecure@docker")+
			logLine("81.2.69.10", "shop.example.com", "/cart", 200, 50, "tugra_shop-web@docker")+ // redirect twin: excluded
			logLine("89.160.20.7", "shop.example.com", "/", 500, 10, "shop-websecure@docker")+
			logLine("127.0.0.1", "api.example.com", "/", 200, 1, "api@internal")+ // internal: excluded
			"garbage line\n"+
			logLine("10.0.0.5", "shop.example.com", "/", 304, 0, "shop-websecure@docker"),
	)
	c.ingestNew()
	m := c.flushAt(time.Now())
	if m == nil || len(m.Domains) != 1 {
		t.Fatalf("m=%+v", m)
	}
	d := m.Domains[0]
	if d.Host != "shop.example.com" || d.Requests != 3 || d.S2xx != 1 || d.S3xx != 1 || d.S5xx != 1 || d.Bytes != 110 {
		t.Fatalf("d=%+v", d)
	}
	if len(d.Countries) != 2 {
		t.Fatalf("countries=%+v", d.Countries)
	}

	// Privacy: the serialized message carries only host, counts, paths, country codes and anonymized
	// aggregates (a /24 network, never a full address; see TestCollectorDimensionsNoRawLeak).
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, forbidden := range []string{"81.2.69.10", "89.160.20.7", "10.0.0.5", "127.0.0.1", "secret", "token", "ClientHost", "clientIP", "User-Agent", "Cookie", ":443"} {
		if strings.Contains(s, forbidden) {
			t.Fatalf("message leaks %q: %s", forbidden, s)
		}
	}
	var generic map[string]any
	if err := json.Unmarshal(b, &generic); err != nil {
		t.Fatal(err)
	}
	for k := range generic {
		switch k {
		case "type", "ts", "windowSec", "domains":
		default:
			t.Fatalf("unexpected top-level field %q", k)
		}
	}
	dom := generic["domains"].([]any)[0].(map[string]any)
	for k := range dom {
		switch k {
		case "host", "requests", "s2xx", "s3xx", "s4xx", "s5xx", "bytes", "paths", "countries",
			"browsers", "os", "devices", "referrers", "cities", "networks", "bots", "latency", "unique":
		default:
			t.Fatalf("unexpected domain field %q", k)
		}
	}
}

func TestCollectorNoDBStillCounts(t *testing.T) {
	t.Setenv(geoIPEnv, filepath.Join(t.TempDir(), "absent.mmdb"))
	p := filepath.Join(t.TempDir(), "access.json")
	appendFile(t, p, "")
	c := newCollector(p, loadGeo(), time.Now())
	appendFile(t, p, logLine("81.2.69.10", "a.com", "/", 200, 5, "r@docker"))
	c.ingestNew()
	m := c.flushAt(time.Now())
	if m == nil || m.Domains[0].Requests != 1 || len(m.Domains[0].Countries) != 0 {
		t.Fatalf("m=%+v", m)
	}
}

func TestCollectorIdleWhenLogMissing(t *testing.T) {
	c := newCollector(filepath.Join(t.TempDir(), "access.json"), nil, time.Now())
	c.ingestNew()
	if c.flushAt(time.Now()) != nil {
		t.Fatal("no log -> nothing to send")
	}
}
