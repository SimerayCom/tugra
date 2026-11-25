package coolify

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/SimerayCom/tugra/agent/internal/coolify/open"
)

// The canary leak test. Known plaintexts (and the app key) are planted in a fake Coolify; the whole pipeline runs; then every surface
// the agent can emit is searched for them: the frames sent to the hub, the log, every command line, the SQL, the files it wrote, and
// the helper's stderr. A canary counts as leaked when it appears raw, base64 (std or url), hex or URL-encoded, or when any 8-byte
// window of it appears. The search itself is proven by a positive control (a planted leak in each form is found) and by the
// `leaky` build tag (a helper that really prints a plaintext must make this very test see it).

type canary struct {
	name string
	val  []byte
}

func newCanaries() []canary {
	rnd := func(n int) []byte { b := make([]byte, n); _, _ = rand.Read(b); return b }
	tok := func(prefix string) []byte { return []byte(prefix + strings.ToLower(hex.EncodeToString(rnd(10)))) }
	return []canary{
		{"env value", tok("cnr-env-")},
		{"db password", tok("cnr-dbp-")},
		{"s3 secret", tok("cnr-s3s-")},
		{"unicode value", []byte("ç" + string(tok("cnr-uni-")) + "€")},
		{"old-key value", tok("cnr-old-")},
	}
}

func windows(b []byte, n int) [][]byte {
	if len(b) <= n {
		return [][]byte{b}
	}
	var out [][]byte
	for i := 0; i+n <= len(b); i++ {
		out = append(out, b[i:i+n])
	}
	return out
}

// needles lists everything that must not appear in a surface for this secret.
func needles(secret []byte) [][]byte {
	forms := [][]byte{
		secret,
		[]byte(base64.StdEncoding.EncodeToString(secret)),
		[]byte(base64.RawStdEncoding.EncodeToString(secret)),
		[]byte(base64.URLEncoding.EncodeToString(secret)),
		[]byte(base64.RawURLEncoding.EncodeToString(secret)),
		[]byte(hex.EncodeToString(secret)),
		[]byte(strings.ToUpper(hex.EncodeToString(secret))),
		[]byte(url.QueryEscape(string(secret))),
		[]byte(url.PathEscape(string(secret))),
	}
	// base64 of the secret at the three possible alignments inside a larger string
	for shift := 1; shift <= 2; shift++ {
		enc := base64.StdEncoding.EncodeToString(append(bytes.Repeat([]byte{'#'}, shift), secret...))
		forms = append(forms, []byte(enc[4:len(enc)-4]))
	}
	out := append([][]byte(nil), forms...)
	out = append(out, windows(secret, 8)...) // any 8 raw bytes
	out = append(out, windows([]byte(hex.EncodeToString(secret)), 16)...)
	return out
}

// find returns the names of the secrets that leak into surface.
func find(surface []byte, secrets []canary) []string {
	var hit []string
	for _, c := range secrets {
		for _, n := range needles(c.val) {
			if len(n) > 0 && bytes.Contains(surface, n) {
				hit = append(hit, c.name)
				break
			}
		}
	}
	return hit
}

// Positive control: the scanner finds a planted leak in every form it claims to cover, and stays quiet on clean text.
func TestCanaryScannerFindsEveryEncoding(t *testing.T) {
	c := canary{"probe", []byte("cnr-probe-0123456789abcdef-Z")}
	forms := map[string]string{
		"raw":          string(c.val),
		"base64":       base64.StdEncoding.EncodeToString(c.val),
		"base64 raw":   base64.RawStdEncoding.EncodeToString(c.val),
		"base64url":    base64.URLEncoding.EncodeToString(c.val),
		"hex":          hex.EncodeToString(c.val),
		"HEX":          strings.ToUpper(hex.EncodeToString(c.val)),
		"url":          url.QueryEscape(string(c.val)),
		"8-byte slice": string(c.val[5:13]),
		"inside text":  "prefix " + string(c.val) + " suffix",
		"shift 1":      strings.TrimSuffix(base64.StdEncoding.EncodeToString(append([]byte("#"), c.val...))[4:], "="),
		"shift 2":      base64.StdEncoding.EncodeToString(append([]byte("##"), c.val...))[4:],
	}
	for name, f := range forms {
		if hit := find([]byte("noise "+f+" noise"), []canary{c}); len(hit) != 1 {
			t.Errorf("scanner missed the %s form", name)
		}
	}
	if hit := find([]byte("docker run --rm --network none tse1.AAAA clean text"), []canary{c}); len(hit) != 0 {
		t.Errorf("false positive on clean text: %v", hit)
	}
}

// secretsLeakedIn runs the whole pipeline over fresh canaries and returns every leak found, with the surface it was found in.
func runCanaryPipeline(t *testing.T) (leaks []string, plainOK bool) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("TMPDIR", dir)

	cs := newCanaries()
	appKeyRaw := make([]byte, 32)
	_, _ = rand.Read(appKeyRaw)
	oldKeyRaw := make([]byte, 32)
	_, _ = rand.Read(oldKeyRaw)
	appKey := "base64:" + base64.StdEncoding.EncodeToString(appKeyRaw)
	oldKey := "base64:" + base64.StdEncoding.EncodeToString(oldKeyRaw)

	host := newFakeHost(appKey)
	host.prevKeys = oldKey
	host.put("environment_variables", "e1", "value", sp(laravelEncryptCBC(t, appKeyRaw, phpSerialize(string(cs[0].val)))))
	host.put("standalone_postgresqls", "d1", "postgres_password", sp(laravelEncryptCBC(t, appKeyRaw, cs[1].val)))
	host.put("s3_storages", "s1", "secret", sp(laravelEncryptCBC(t, appKeyRaw, cs[2].val)))
	host.put("s3_storages", "s1", "key", sp(laravelEncryptCBC(t, appKeyRaw, cs[3].val)))
	host.put("environment_variables", "e2", "value", sp(laravelEncryptCBC(t, oldKeyRaw, phpSerialize(string(cs[4].val)))))
	// a few values that fail, so the error paths are exercised too
	host.put("environment_variables", "bad", "value", sp(laravelEncryptCBC(t, make([]byte, 32), phpSerialize("whatever"))))
	h := newHarness(t, host)
	res := h.send(h.frame([]string{"env", "db_credentials", "s3"}, []string{"env:e1", "env:e2", "env:bad", "database:d1", "s3:s1"}, nil))

	plain, codes := h.openRecords(res)
	plainOK = plain["env:e1|value"] == string(cs[0].val) && plain["database:d1|postgres_password"] == string(cs[1].val) &&
		plain["s3:s1|secret"] == string(cs[2].val) && plain["s3:s1|key"] == string(cs[3].val) && plain["env:e2|value"] == string(cs[4].val) &&
		codes["env:bad|value"] == "bad_mac"

	all := append(append([]canary(nil), cs...),
		canary{"app key text", []byte(appKey)}, canary{"app key bytes", appKeyRaw}, canary{"app key b64", []byte(base64.StdEncoding.EncodeToString(appKeyRaw))},
		canary{"previous key text", []byte(oldKey)}, canary{"previous key bytes", oldKeyRaw})

	surfaces := map[string][]byte{}
	var frames bytes.Buffer
	for _, f := range h.frames {
		frames.Write(f)
		frames.WriteByte('\n')
	}
	surfaces["frames to the hub"] = frames.Bytes()
	surfaces["agent log"] = h.logs.Bytes()
	var argv, sql bytes.Buffer
	for _, a := range host.argvs {
		argv.WriteString(strings.Join(a, "\x00"))
		argv.WriteByte('\n')
	}
	for _, s := range host.psqlSQL {
		sql.WriteString(s)
	}
	surfaces["command lines"] = argv.Bytes()
	surfaces["sql"] = sql.Bytes()
	surfaces["helper stderr"] = host.helperErr.Bytes()
	var files bytes.Buffer
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			b, _ := os.ReadFile(p)
			files.WriteString(p)
			files.Write(b)
		}
		return nil
	})
	surfaces["files written"] = files.Bytes()
	// What goes INTO the helper is ciphertext plus the key: the values must not be there in the clear. (The key legitimately is.)
	surfaces["helper stdin (rows)"] = bytes.ReplaceAll(host.helperIn.Bytes(), []byte(appKey), nil)

	for name, s := range surfaces {
		surf := s
		for _, k := range []canary{{"x", nil}} {
			_ = k
		}
		set := all
		if name == "helper stdin (rows)" {
			set = all[:5] // the key is part of that stream by design; the values are not
		}
		for _, hit := range find(surf, set) {
			leaks = append(leaks, fmt.Sprintf("%s leaked in %s", hit, name))
		}
	}
	return leaks, plainOK
}

func TestCanaryPipeline(t *testing.T) {
	leaks, plainOK := runCanaryPipeline(t)
	if !plainOK {
		t.Fatal("the pipeline did not return the right values; a leak test over a broken pipeline proves nothing")
	}
	if open.Leaky {
		// Negative control: this binary was built with the deliberate leak, so the scan MUST see it.
		if len(leaks) == 0 {
			t.Fatal("negative control failed: a helper that prints plaintext was NOT detected")
		}
		t.Logf("negative control ok, the scan caught: %v", leaks)
		return
	}
	if len(leaks) > 0 {
		t.Fatalf("secret material leaked: %v", leaks)
	}
}

// Runs the same test with `-tags leaky` in a child process: there the helper prints plaintext and TestCanaryPipeline must see it.
func TestLeakyBuildIsCaught(t *testing.T) {
	if open.Leaky || testing.Short() || os.Getenv("TUGRA_CANARY_CHILD") == "1" {
		t.Skip("parent run only")
	}
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go tool not available")
	}
	cmd := exec.Command(goBin, "test", "-count=1", "-tags", "leaky", "-run", "^TestCanaryPipeline$", "-v", ".")
	cmd.Env = append(os.Environ(), "TUGRA_CANARY_CHILD=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("the leaky build was not caught by the canary test:\n%s", out)
	}
	if !strings.Contains(string(out), "negative control ok") {
		t.Fatalf("the leaky run did not take the negative-control path:\n%s", out)
	}
}
