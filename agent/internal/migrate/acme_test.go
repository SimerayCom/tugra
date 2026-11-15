package migrate

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const testToken = "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

// genCert makes a self-signed ECDSA cert for hosts and returns (certPEM, keyPEM).
func genCert(t testing.TB, notAfter time.Time, hosts ...string) (string, string) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return genCertWithKey(t, k, notAfter, hosts...)
}

func genCertWithKey(t testing.TB, k *ecdsa.PrivateKey, notAfter time.Time, hosts ...string) (string, string) {
	t.Helper()
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: hosts[0]},
		DNSNames:     hosts,
		NotBefore:    time.Now().Add(-48 * time.Hour),
		NotAfter:     notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	kb, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}))
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

type entry struct {
	main string
	sans []string
	cert string
	key  string
}

// resolverJSON renders one acme.json resolver object with an obviously-marked account key.
func resolverJSON(entries ...entry) string {
	var certs []string
	for _, e := range entries {
		sans, _ := json.Marshal(e.sans)
		certs = append(certs, fmt.Sprintf(`{"domain":{"main":%q,"sans":%s},"certificate":%q,"key":%q,"Store":"default"}`,
			e.main, sans, b64(e.cert), b64(e.key)))
	}
	return fmt.Sprintf(`{"Account":{"Email":"ops@example.com","Registration":{"uri":"https://acme/acct/1"},"PrivateKey":"%s","KeyType":"4096"},"Certificates":[%s]}`,
		accountMarker, strings.Join(certs, ","))
}

const accountMarker = "ACCOUNT-PRIVATE-KEY-MARKER-9f3a"

func wantSet(h ...string) map[string]struct{} {
	m := map[string]struct{}{}
	for _, x := range h {
		m[x] = struct{}{}
	}
	return m
}

func future() time.Time { return time.Now().Add(60 * 24 * time.Hour) }

func TestParseAcmeStore_DropsAccountKey(t *testing.T) {
	c, k := genCert(t, future(), "a.example.com")
	in := `{"le":` + resolverJSON(entry{"a.example.com", nil, c, k}) + `}`
	certs, st, err := ParseAcmeStore(strings.NewReader(in), wantSet("a.example.com"))
	if err != nil || len(certs) != 1 {
		t.Fatalf("certs=%d err=%v st=%+v", len(certs), err, st)
	}
	out, _ := json.Marshal(CertsBundle{ServerRef: "s", Certs: certs})
	for _, hay := range []string{string(out), fmt.Sprintf("%+v %+v", certs, st), certs[0].CertPEM, certs[0].KeyPEM} {
		if strings.Contains(hay, accountMarker) || strings.Contains(hay, b64(accountMarker)) {
			t.Fatal("the ACME account key leaked into the output")
		}
	}
	if strings.Contains(string(out), "Account") || strings.Contains(string(out), "Registration") {
		t.Fatal("account object leaked")
	}
}

func TestParseAcmeStore_IteratesAllResolvers(t *testing.T) {
	c1, k1 := genCert(t, future(), "a.example.com")
	c2, k2 := genCert(t, future(), "b.example.com")
	c3, k3 := genCert(t, future(), "c.example.com")
	in := `{"zeta":` + resolverJSON(entry{"a.example.com", nil, c1, k1}) +
		`,"letsencrypt":` + resolverJSON(entry{"b.example.com", nil, c2, k2}) +
		`,"custom-dns":` + resolverJSON(entry{"c.example.com", nil, c3, k3}) +
		`,"junk":"not-an-object","nul":null}`
	certs, st, err := ParseAcmeStore(strings.NewReader(in), wantSet("a.example.com", "b.example.com", "c.example.com"))
	if err != nil || len(certs) != 3 || st.Total != 3 || st.Matched != 3 {
		t.Fatalf("certs=%d err=%v st=%+v", len(certs), err, st)
	}
}

func TestParseAcmeStore_FiltersToWanted(t *testing.T) {
	c1, k1 := genCert(t, future(), "a.example.com", "www.a.example.com")
	c2, k2 := genCert(t, future(), "other.example.com")
	c3, k3 := genCert(t, future(), "x.example.com")
	in := `{"le":` + resolverJSON(
		entry{"a.example.com", []string{"www.a.example.com"}, c1, k1},
		entry{"other.example.com", nil, c2, k2},
		entry{"x.example.com", []string{"Wanted-San.Example.com"}, c3, k3},
	) + `}`
	// wanted matches a cert by its SAN only, case-insensitively; one cert is unwanted.
	certs, st, err := ParseAcmeStore(strings.NewReader(in), wantSet("www.a.example.com", "wanted-san.example.com"))
	if err != nil {
		t.Fatal(err)
	}
	if len(certs) != 2 || st.DroppedNotWanted != 1 || st.Matched != 2 || st.Total != 3 {
		t.Fatalf("certs=%d st=%+v", len(certs), st)
	}
	for _, c := range certs {
		if c.Main == "other.example.com" {
			t.Fatal("unwanted cert returned")
		}
	}
}

func TestParseAcmeStore_RejectsOversize(t *testing.T) {
	big := `{"le":{"Certificates":[],"pad":"` + strings.Repeat("A", acmeMaxFileBytes) + `"}}`
	if _, _, err := ParseAcmeStore(strings.NewReader(big), wantSet("a.example.com")); err == nil || !strings.Contains(err.Error(), "acme store too large") {
		t.Fatalf("want too-large error, got %v", err)
	}
	// an oversized individual PEM is malformed, not fatal
	c, k := genCert(t, future(), "a.example.com")
	huge := c + strings.Repeat("# pad\n", acmeMaxPEMBytes/6+10)
	in := `{"le":` + resolverJSON(entry{"a.example.com", nil, huge, k}) + `}`
	certs, st, err := ParseAcmeStore(strings.NewReader(in), wantSet("a.example.com"))
	if err != nil || len(certs) != 0 || st.DroppedMalformed != 1 {
		t.Fatalf("certs=%d st=%+v err=%v", len(certs), st, err)
	}
}

func TestParseAcmeStore_CapsEntries(t *testing.T) {
	var es []entry
	for i := 0; i < acmeMaxCerts+25; i++ {
		es = append(es, entry{main: fmt.Sprintf("h%d.example.com", i), cert: "x", key: "y"})
	}
	_, st, err := ParseAcmeStore(strings.NewReader(`{"le":`+resolverJSON(es...)+`}`), wantSet())
	if err != nil || st.Total != acmeMaxCerts {
		t.Fatalf("total=%d err=%v", st.Total, err)
	}
}

func TestParseAcmeStore_SkipsExpired(t *testing.T) {
	c, k := genCert(t, time.Now().Add(-time.Hour), "a.example.com")
	c2, k2 := genCert(t, future(), "b.example.com")
	in := `{"le":` + resolverJSON(entry{"a.example.com", nil, c, k}, entry{"b.example.com", nil, c2, k2}) + `}`
	certs, st, err := ParseAcmeStore(strings.NewReader(in), wantSet("a.example.com", "b.example.com"))
	if err != nil || len(certs) != 1 || certs[0].Main != "b.example.com" || st.DroppedExpired != 1 {
		t.Fatalf("certs=%+v st=%+v err=%v", certs, st, err)
	}
}

func TestParseAcmeStore_SkipsKeyMismatch(t *testing.T) {
	c, _ := genCert(t, future(), "a.example.com")
	_, otherKey := genCert(t, future(), "zzz.example.com")
	in := `{"le":` + resolverJSON(entry{"a.example.com", nil, c, otherKey}) + `}`
	certs, st, err := ParseAcmeStore(strings.NewReader(in), wantSet("a.example.com"))
	if err != nil || len(certs) != 0 || st.DroppedMalformed != 1 {
		t.Fatalf("certs=%+v st=%+v err=%v", certs, st, err)
	}
}

func TestParseAcmeStore_MalformedVariants(t *testing.T) {
	c, k := genCert(t, future(), "a.example.com")
	mk := func(cert, key string) string {
		return fmt.Sprintf(`{"le":{"Certificates":[{"domain":{"main":"a.example.com"},"certificate":%q,"key":%q}]}}`, cert, key)
	}
	for name, in := range map[string]string{
		"bad-b64":   mk("!!!notbase64!!!", b64(k)),
		"no-pem":    mk(b64("hello"), b64(k)),
		"empty":     mk("", ""),
		"key-isnt":  mk(b64(c), b64(c)),
		"no-domain": `{"le":{"Certificates":[{"domain":{},"certificate":"x","key":"y"}]}}`,
	} {
		certs, st, err := ParseAcmeStore(strings.NewReader(in), wantSet("a.example.com"))
		if err != nil || len(certs) != 0 || st.DroppedMalformed != 1 {
			t.Errorf("%s: certs=%d st=%+v err=%v", name, len(certs), st, err)
		}
	}
	// padding-stripped base64 is tolerated
	in := mk(strings.TrimRight(b64(c), "="), strings.TrimRight(b64(k), "="))
	if certs, _, _ := ParseAcmeStore(strings.NewReader(in), wantSet("a.example.com")); len(certs) != 1 {
		t.Error("unpadded base64 should be accepted")
	}
}

func TestParseAcmeStore_DedupKeepsLaterNotAfter(t *testing.T) {
	c1, k1 := genCert(t, time.Now().Add(30*24*time.Hour), "a.example.com")
	c2, k2 := genCert(t, time.Now().Add(80*24*time.Hour), "a.example.com")
	in := `{"le":` + resolverJSON(entry{"a.example.com", nil, c1, k1}, entry{"a.example.com", nil, c2, k2}) + `}`
	certs, _, err := ParseAcmeStore(strings.NewReader(in), wantSet("a.example.com"))
	if err != nil || len(certs) != 1 || certs[0].CertPEM != c2 {
		t.Fatalf("want the later-expiring cert, got %d err=%v", len(certs), err)
	}
}

func FuzzParseAcmeStore(f *testing.F) {
	c, k := genCert(f, future(), "a.example.com")
	f.Add([]byte(`{"le":` + resolverJSON(entry{"a.example.com", nil, c, k}) + `}`))
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"le":{"Certificates":[{"domain":{"main":"a"},"certificate":"AAAA","key":"BBBB"}]}}`))
	f.Add([]byte(`{"le":null,"x":[1,2],"y":"z"}`))
	f.Add([]byte(`[`))
	f.Fuzz(func(t *testing.T, data []byte) {
		_, _, _ = ParseAcmeStore(bytes.NewReader(data), wantSet("a", "a.example.com"))
	})
}

// ---- FindAcmeStore --------------------------------------------------------------------------

func stubInspect(t *testing.T, out string, err error) {
	t.Helper()
	orig := runDocker
	t.Cleanup(func() { runDocker = orig })
	runDocker = func(ctx context.Context, argv []string, env []string) ([]byte, string, error) {
		if len(argv) >= 2 && argv[1] == "inspect" {
			return []byte(out), "", err
		}
		return nil, "", fmt.Errorf("unexpected argv %v", argv)
	}
}

func setFallback(t *testing.T, p string) {
	t.Helper()
	orig := acmeFallbackPath
	t.Cleanup(func() { acmeFallbackPath = orig })
	acmeFallbackPath = p
}

func TestFindAcmeStore_FallbackPath(t *testing.T) {
	dir := t.TempDir()
	fb := filepath.Join(dir, "acme.json")
	if err := os.WriteFile(fb, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	setFallback(t, fb)

	stubInspect(t, "", fmt.Errorf("exit 1")) // docker inspect fails
	got, err := FindAcmeStore(context.Background(), "/usr/bin/docker", "coolify-proxy", nil)
	if err != nil || got != fb {
		t.Fatalf("inspect-fail: got %q err=%v", got, err)
	}
	stubInspect(t, `[{"Type":"bind","Source":"/srv/other","Destination":"/data"}]`, nil) // nothing matching
	got, err = FindAcmeStore(context.Background(), "/usr/bin/docker", "coolify-proxy", nil)
	if err != nil || got != fb {
		t.Fatalf("no-match: got %q err=%v", got, err)
	}
	stubInspect(t, `garbage`, nil)
	if got, err = FindAcmeStore(context.Background(), "/usr/bin/docker", "coolify-proxy", nil); err != nil || got != fb {
		t.Fatalf("garbage: got %q err=%v", got, err)
	}
}

func TestFindAcmeStore_MountMapping(t *testing.T) {
	root := t.TempDir()
	proxy := filepath.Join(root, "proxy")
	if err := os.MkdirAll(proxy, 0o755); err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(proxy, "acme.json")
	if err := os.WriteFile(f, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	setFallback(t, filepath.Join(root, "nope", "acme.json"))
	for name, mounts := range map[string]string{
		"traefik-dir": fmt.Sprintf(`[{"Type":"bind","Source":%q,"Destination":"/traefik"}]`, proxy),
		"letsencrypt": fmt.Sprintf(`[{"Type":"bind","Source":%q,"Destination":"/letsencrypt"}]`, proxy),
		"file-mount":  fmt.Sprintf(`[{"Type":"bind","Source":%q,"Destination":"/etc/acme.json"}]`, f),
	} {
		stubInspect(t, mounts, nil)
		got, err := FindAcmeStore(context.Background(), "/usr/bin/docker", "my-proxy", nil)
		if err != nil || got != f {
			t.Errorf("%s: got %q err=%v", name, got, err)
		}
	}
}

func TestFindAcmeStore_RejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real.json")
	link := filepath.Join(dir, "acme.json")
	if err := os.WriteFile(real, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symlinks unavailable")
	}
	setFallback(t, link)
	stubInspect(t, "", fmt.Errorf("exit 1"))
	if _, err := FindAcmeStore(context.Background(), "/usr/bin/docker", "coolify-proxy", nil); err == nil {
		t.Fatal("a symlinked acme.json must be rejected")
	}
	if _, err := openAcmeStore(link); err == nil {
		t.Fatal("openAcmeStore must reject a symlink")
	}
	// a directory is not a regular file either
	setFallback(t, dir)
	if _, err := FindAcmeStore(context.Background(), "/usr/bin/docker", "coolify-proxy", nil); err == nil {
		t.Fatal("a directory must be rejected")
	}
}

func TestFindAcmeStore_RejectsBadContainerName(t *testing.T) {
	called := false
	orig := runDocker
	t.Cleanup(func() { runDocker = orig })
	runDocker = func(ctx context.Context, argv []string, env []string) ([]byte, string, error) {
		called = true
		return nil, "", fmt.Errorf("x")
	}
	setFallback(t, filepath.Join(t.TempDir(), "missing.json"))
	_, _ = FindAcmeStore(context.Background(), "/usr/bin/docker", "--bad", nil)
	if called {
		t.Fatal("an unsafe container name must never reach docker")
	}
}

// ---- runCerts / RunCLI wiring ---------------------------------------------------------------

// certsHub is a scripted hub for --certs e2e: no DB targets, a wanted list, and a recording PUT /certs.
type certsHub struct {
	mu       sync.Mutex
	calls    []string
	wanted   string
	putBody  []byte
	putCT    string
	putCode  int
	putReply string
	targets  string
}

func (h *certsHub) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		p := strings.TrimPrefix(r.URL.Path, "/api/v1/import/migration/")
		h.calls = append(h.calls, r.Method+" "+p)
		switch {
		case p == "probe":
			io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
		case p == "recipes":
			spec := engineSpecs["POSTGRES"]
			io.WriteString(w, `{"v":1,"recipes":{"POSTGRES":{"command":`+jsonStr(spec.golden)+`,"format":"pg_custom","pgFormat":"custom","env":[{"name":"PGPASSWORD","from":"pw"}]}},"unsupported":{}}`)
		case p == "targets":
			t := h.targets
			if t == "" {
				t = `[]`
			}
			io.WriteString(w, `{"opId":"op1","targets":`+t+`,"maxArtifactBytes":268435456}`)
		case p == "certs/wanted":
			io.WriteString(w, h.wanted)
		case p == "certs" && r.Method == http.MethodPut:
			h.putBody, _ = io.ReadAll(r.Body)
			h.putCT = r.Header.Get("Content-Type")
			if h.putCode != 0 {
				w.WriteHeader(h.putCode)
			}
			io.WriteString(w, h.putReply)
		default:
			w.WriteHeader(404)
		}
	})
}

func needDockerOnPath(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

func writeAcme(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "acme.json")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRunCerts_NoLogOfPEM(t *testing.T) {
	needDockerOnPath(t)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	c, k := genCert(t, future(), "a.example.com")
	acme := writeAcme(t, `{"le":`+resolverJSON(entry{"a.example.com", nil, c, k})+`}`)

	hub := &certsHub{wanted: `{"hosts":["a.example.com"],"serverRef":"srv-1"}`, putReply: `{"accepted":1,"rejected":[]}`}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()

	var stdout, stderr bytes.Buffer
	code := RunCLI([]string{"--hub", srv.URL, "--certs", "--acme-file", acme}, "test", &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	all := stdout.String() + stderr.String()
	keyBody := strings.TrimSpace(strings.NewReplacer("-----BEGIN EC PRIVATE KEY-----", "", "-----END EC PRIVATE KEY-----", "", "\n", "").Replace(k))
	for _, bad := range []string{"BEGIN", "PRIVATE KEY", keyBody, b64(k), b64(c), accountMarker} {
		if strings.Contains(all, bad) {
			t.Fatalf("output leaks %q:\n%s", bad[:min(len(bad), 20)], all)
		}
	}
	if !strings.Contains(stderr.String(), "certs: sent 1, accepted 1, rejected 0") {
		t.Fatalf("missing count line:\n%s", stderr.String())
	}
	// the hub did receive the cert, as a raw octet-stream body, with no account object.
	if hub.putCT != "application/octet-stream" {
		t.Fatalf("content-type=%q", hub.putCT)
	}
	var b CertsBundle
	if err := json.Unmarshal(hub.putBody, &b); err != nil || len(b.Certs) != 1 || b.ServerRef != "srv-1" || b.Certs[0].KeyPEM != k {
		t.Fatalf("bundle wrong: %v %+v", err, b)
	}
	if strings.Contains(string(hub.putBody), accountMarker) {
		t.Fatal("account key was transmitted")
	}
	var out output
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); err != nil || out.Certs == nil || out.Certs.State != "done" || !out.NoTargets {
		t.Fatalf("output: %v %+v", err, out)
	}
}

func TestRunCerts_ScrubberRedactsPEM(t *testing.T) {
	c, k := genCert(t, future(), "a.example.com")
	sc := &scrubber{}
	registerPEM(sc, k)
	registerPEM(sc, c)
	for _, s := range []string{k, c, b64(k), "x " + strings.TrimSpace(k) + " y"} {
		if strings.Contains(sc.scrub(s), "BEGIN") || strings.Contains(sc.scrub(s), b64(k)) {
			t.Fatalf("scrubber let key material through: %q", sc.scrub(s))
		}
	}
}

func TestRunCerts_MissingFileSkips(t *testing.T) {
	needDockerOnPath(t)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	hub := &certsHub{wanted: `{"hosts":["a.example.com"]}`}
	srv := httptest.NewServer(hub.handler())
	defer srv.Close()

	var stdout, stderr bytes.Buffer
	missing := filepath.Join(t.TempDir(), "nope.json")
	code := RunCLI([]string{"--hub", srv.URL, "--certs", "--acme-file", missing}, "test", &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit=%d want 0; stderr=%s", code, stderr.String())
	}
	var out output
	_ = json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out)
	if out.Certs == nil || out.Certs.State != "skipped" || out.Certs.Reason != certsSkipNoStore {
		t.Fatalf("certs result: %+v", out.Certs)
	}
	for _, c := range hub.calls {
		if c == "PUT certs" {
			t.Fatal("nothing should be sent when the store is missing")
		}
	}

	// via docker-inspect fallback (no --acme-file) the same happens
	setFallback(t, missing)
	stubInspect(t, "", fmt.Errorf("exit 1"))
	stdout.Reset()
	stderr.Reset()
	if code := RunCLI([]string{"--hub", srv.URL, "--certs"}, "test", &stdout, &stderr); code != exitOK {
		t.Fatalf("fallback exit=%d stderr=%s", code, stderr.String())
	}
}

func TestRunCerts_DoesNotAbortDataItems(t *testing.T) {
	// with a DB target present and a missing acme store, the DB still restores and exit is 0.
	hs := &hubState{restored: map[string]bool{}, status0: "none"}
	inner := hs.handler(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/certs/wanted") {
			io.WriteString(w, `{"hosts":["a.example.com"]}`)
			return
		}
		inner.ServeHTTP(w, r)
	}))
	defer srv.Close()
	installDumpStub(t)
	withFakeDocker(t, []fakeContainer{{id: pgID, name: "mypg", image: "postgres:16", running: true,
		envv: []string{"POSTGRES_USER=app", "POSTGRES_PASSWORD=pw", "POSTGRES_DB=appdb"}}})
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)

	var stdout, stderr bytes.Buffer
	code := RunCLI([]string{"--hub", srv.URL, "--certs", "--acme-file", filepath.Join(t.TempDir(), "x.json")}, "test", &stdout, &stderr)
	var out output
	_ = json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out)
	if code != exitOK || out.Counts.Restored != 1 || out.Certs == nil || out.Certs.State != "skipped" {
		t.Fatalf("code=%d out=%+v stderr=%s", code, out, stderr.String())
	}
}

func TestRunCerts_HubErrors(t *testing.T) {
	needDockerOnPath(t)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	noSleep(t)
	c, k := genCert(t, future(), "a.example.com")
	acme := writeAcme(t, `{"le":`+resolverJSON(entry{"a.example.com", nil, c, k})+`}`)

	cases := []struct {
		name   string
		hub    *certsHub
		want   int
		state  string
		reason string
	}{
		{"put-401", &certsHub{wanted: `{"hosts":["a.example.com"]}`, putCode: 401, putReply: `{"message":"no"}`}, exitAuth, "failed", ""},
		{"put-rejected", &certsHub{wanted: `{"hosts":["a.example.com"]}`, putReply: `{"accepted":0,"rejected":[{"main":"a.example.com","reason":"nope"}]}`}, exitPartial, "partial", ""},
		{"wanted-empty", &certsHub{wanted: `{"hosts":[]}`}, exitOK, "skipped", certsSkipNoWanted},
		{"wanted-bad-shape", &certsHub{wanted: `not json`}, exitSkew, "failed", ""},
		{"no-match", &certsHub{wanted: `{"hosts":["zzz.example.org"]}`}, exitOK, "skipped", certsSkipNoneMatched},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(tc.hub.handler())
			defer srv.Close()
			var stdout, stderr bytes.Buffer
			code := RunCLI([]string{"--hub", srv.URL, "--certs", "--acme-file", acme}, "test", &stdout, &stderr)
			var out output
			_ = json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out)
			if code != tc.want || out.Certs == nil || out.Certs.State != tc.state || (tc.reason != "" && out.Certs.Reason != tc.reason) {
				t.Fatalf("code=%d want %d certs=%+v stderr=%s", code, tc.want, out.Certs, stderr.String())
			}
			if strings.Contains(stdout.String()+stderr.String(), "BEGIN") {
				t.Fatal("PEM printed")
			}
		})
	}
}

func TestRunCerts_FlagOffIsByteIdentical(t *testing.T) {
	needDockerOnPath(t)
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)

	run := func(args ...string) (int, string, string, []string) {
		hub := &certsHub{wanted: `{"hosts":["a.example.com"]}`, targets: `[]`, putReply: `{"accepted":1,"rejected":[]}`}
		srv := httptest.NewServer(hub.handler())
		defer srv.Close()
		var stdout, stderr bytes.Buffer
		code := RunCLI(append([]string{"--hub", srv.URL}, args...), "test", &stdout, &stderr)
		// normalise the ephemeral port out of the output
		return code, strings.ReplaceAll(stdout.String(), srv.URL, "HUB"), strings.ReplaceAll(stderr.String(), srv.URL, "HUB"), hub.calls
	}

	code, stdout, stderr, calls := run()
	wantOut := `{"tool":"tugra-migrate","version":"test","schema":1,"ok":true,"exit":0,"code":"ok","opId":"op1","recipesV":1,"hub":"HUB","noTargets":true,"counts":{"restored":0,"alreadyRestored":0,"failed":0,"skipped":0,"unsupported":0,"unconfirmed":0},"items":[]}` + "\n"
	if code != 0 || stdout != wantOut || stderr != "" {
		t.Fatalf("flag-off output drifted:\ncode=%d\nstdout=%s\nstderr=%q", code, stdout, stderr)
	}
	if got := strings.Join(calls, ","); got != "GET probe,GET recipes,GET targets" {
		t.Fatalf("flag-off call sequence drifted: %s", got)
	}
	if strings.Contains(stdout, `"certs"`) {
		t.Fatal("certs key must be absent with the flag off")
	}

	// explicit --proxy-container without --certs changes nothing either
	code2, stdout2, _, calls2 := run("--proxy-container", "other-proxy")
	if code2 != 0 || stdout2 != wantOut || len(calls2) != 3 {
		t.Fatalf("--proxy-container alone must be inert: %s %v", stdout2, calls2)
	}

	// flag on adds exactly the cert GET (empty store/none matched -> skipped) after the data phase.
	c, k := genCert(t, future(), "a.example.com")
	acme := writeAcme(t, `{"le":`+resolverJSON(entry{"a.example.com", nil, c, k})+`}`)
	_, stdout3, _, calls3 := run("--certs", "--acme-file", acme)
	if got := strings.Join(calls3, ","); got != "GET probe,GET recipes,GET targets,GET certs/wanted,PUT certs" {
		t.Fatalf("flag-on call sequence: %s", got)
	}
	if !strings.Contains(stdout3, `"certs":{"state":"done","sent":1,"accepted":1}`) {
		t.Fatalf("flag-on output: %s", stdout3)
	}
}

func TestParseFlags_ProxyContainerValidation(t *testing.T) {
	t.Setenv("TUGRA_MIGRATION_TOKEN", testToken)
	for _, bad := range []string{"", "-rm", "a b", "a;b", "../x", strings.Repeat("a", 129), "a/b"} {
		var stdout, stderr bytes.Buffer
		if code := RunCLI([]string{"--hub", "https://h.example", "--proxy-container", bad}, "test", &stdout, &stderr); code != exitUsage {
			t.Errorf("%q: exit=%d want usage", bad, code)
		}
	}
	var stderr bytes.Buffer
	c, err := parseFlags([]string{"--certs", "--proxy-container", "my_proxy.1-a"}, &stderr)
	if err != nil || !c.certs || c.proxyContainer != "my_proxy.1-a" {
		t.Fatalf("valid name rejected: %v %+v", err, c)
	}
	c, err = parseFlags(nil, &stderr)
	if err != nil || c.certs || c.proxyContainer != "coolify-proxy" {
		t.Fatalf("defaults wrong: %v %+v", err, c)
	}
	if _, err := parseFlags([]string{"--acme-file", "relative/acme.json"}, &stderr); err == nil {
		t.Fatal("relative --acme-file must be rejected")
	}
}

func TestPutCerts_RawOctetStream(t *testing.T) {
	var gotCT, gotMethod string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotCT, gotMethod = r.Header.Get("Content-Type"), r.Method
		gotBody, _ = io.ReadAll(r.Body)
		io.WriteString(w, `{"accepted":2,"rejected":[{"main":"x.example.com","reason":"bad"}]}`)
	}))
	defer srv.Close()
	resp, err := newTestHub(t, srv).PutCerts(context.Background(), CertsBundle{ServerRef: "s", Certs: []AcmeCert{{Main: "a", CertPEM: "c", KeyPEM: "k"}}})
	if err != nil || resp.Accepted != 2 || len(resp.Rejected) != 1 || resp.Rejected[0].Main != "x.example.com" {
		t.Fatalf("resp=%+v err=%v", resp, err)
	}
	if gotMethod != "PUT" || gotCT != "application/octet-stream" || !json.Valid(gotBody) {
		t.Fatalf("method=%s ct=%s body=%s", gotMethod, gotCT, gotBody)
	}
}

func TestChunkCerts(t *testing.T) {
	var cs []AcmeCert
	for i := 0; i < 10; i++ {
		cs = append(cs, AcmeCert{Main: fmt.Sprintf("h%d", i), CertPEM: strings.Repeat("c", 300<<10), KeyPEM: "k"})
	}
	chunks := chunkCerts(cs)
	n := 0
	for _, ch := range chunks {
		b, _ := json.Marshal(CertsBundle{Certs: ch})
		if len(b) > 2<<20 {
			t.Fatalf("chunk of %d bytes exceeds the hub cap", len(b))
		}
		n += len(ch)
	}
	if n != 10 || len(chunks) < 2 {
		t.Fatalf("n=%d chunks=%d", n, len(chunks))
	}
}
