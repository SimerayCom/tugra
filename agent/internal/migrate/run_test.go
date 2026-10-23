package migrate

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hubState drives a scripted hub for the e2e tests.
type hubState struct {
	restored map[string]bool // itemRef -> a restore has been POSTed
	status0  string          // the state /status returns before any restore
}

func (hs *hubState) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case strings.HasSuffix(p, "/probe"):
			io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
		case strings.HasSuffix(p, "/recipes"):
			spec := engineSpecs["POSTGRES"]
			io.WriteString(w, `{"v":1,"recipes":{"POSTGRES":{"command":`+jsonStr(spec.golden)+`,"format":"pg_custom","pgFormat":"custom","env":[{"name":"PGPASSWORD","from":"pw"}]}},"unsupported":{}}`)
		case strings.HasSuffix(p, "/targets"):
			io.WriteString(w, `{"opId":"op1","targets":[{"itemRef":"database:_:mypg","kind":"database","engine":"POSTGRES"}],"maxArtifactBytes":268435456}`)
		case strings.HasSuffix(p, "/status"):
			ref := strings.TrimSuffix(strings.TrimPrefix(p, "/api/v1/import/migration/artifacts/"), "/status")
			ref, _ = decodePath(ref)
			state := hs.status0
			if hs.restored[ref] {
				state = "restored"
			}
			fmt.Fprintf(w, `{"itemRef":%q,"state":%q}`, ref, state)
		case strings.HasSuffix(p, "/restore"):
			ref := strings.TrimSuffix(strings.TrimPrefix(p, "/api/v1/import/migration/artifacts/"), "/restore")
			ref, _ = decodePath(ref)
			hs.restored[ref] = true
			w.WriteHeader(202)
			io.WriteString(w, `{"state":"restoring"}`)
		default: // PUT artifact: hash the body like the real hub and echo its own measurements
			b, _ := io.ReadAll(r.Body)
			sum := sha256.Sum256(b)
			ref := strings.TrimPrefix(p, "/api/v1/import/migration/artifacts/")
			ref, _ = decodePath(ref)
			w.WriteHeader(201)
			fmt.Fprintf(w, `{"itemRef":%q,"bytes":%d,"sha256":%q,"gzip":true,"pgFormat":"custom"}`, ref, len(b), hex.EncodeToString(sum[:]))
		}
	})
}

func decodePath(s string) (string, error) {
	// the migrator url.PathEscape's the itemRef; httptest already url-decodes r.URL.Path, so s is raw
	return s, nil
}

// installDumpStub puts a fake `docker` on PATH that emits a valid-looking PG dump for `docker exec`.
func installDumpStub(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	stub := filepath.Join(dir, "docker")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nif [ \"$1\" = exec ]; then printf 'PGDMP-e2e-dump-bytes'; fi\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))
}

func TestRunHappyPath(t *testing.T) {
	hs := &hubState{restored: map[string]bool{}, status0: "none"}
	srv := httptest.NewServer(hs.handler(t))
	defer srv.Close()

	installDumpStub(t)
	// discover's docker ps/inspect is stubbed (the PATH stub only serves the dump exec).
	withFakeDocker(t, []fakeContainer{{
		id: pgID, name: "mypg", image: "postgres:16", running: true,
		envv: []string{"POSTGRES_USER=app", "POSTGRES_PASSWORD=pw", "POSTGRES_DB=appdb"},
	}})
	t.Setenv("TUGRA_MIGRATION_TOKEN", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

	var stdout, stderr bytes.Buffer
	code := RunCLI([]string{"--hub", srv.URL}, "test", &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit=%d (want 0)\nstderr:\n%s", code, stderr.String())
	}
	assertOneJSONLine(t, stdout.Bytes())
	var out output
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Counts.Restored != 1 || len(out.Items) != 1 || out.Items[0].State != "restored" {
		t.Fatalf("unexpected output: %+v", out)
	}
	// no secret leaks into stdout/stderr
	for _, s := range []string{"pw", "tugra_mig_aaaa"} {
		if strings.Contains(stderr.String(), "PGPASSWORD=pw") || strings.Contains(stdout.String(), s) && s == "tugra_mig_aaaa" {
			t.Errorf("possible secret leak for %q", s)
		}
	}
}

func TestRunStatusFirstAlreadyRestored(t *testing.T) {
	hs := &hubState{restored: map[string]bool{}, status0: "restored"} // already restored before we start
	srv := httptest.NewServer(hs.handler(t))
	defer srv.Close()
	// no dump stub / no fake docker needed: status-first must SKIP the dump entirely.
	withFakeDocker(t, []fakeContainer{}) // if discovery ran, it would ErrNotFound -> different result
	t.Setenv("TUGRA_MIGRATION_TOKEN", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

	var stdout, stderr bytes.Buffer
	code := RunCLI([]string{"--hub", srv.URL}, "test", &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("exit=%d want 0; stderr: %s", code, stderr.String())
	}
	var out output
	_ = json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out)
	if out.Counts.AlreadyRestored != 1 || out.Items[0].State != "already-restored" {
		t.Fatalf("status-first should skip the dump: %+v", out)
	}
}

func TestRunUsageErrors(t *testing.T) {
	cases := []struct {
		name  string
		env   string
		args  []string
		want  int
	}{
		{"bad-token", "not-a-token", []string{"--hub", "https://h.example"}, exitUsage},
		{"bad-hub", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", []string{"--hub", "ftp://h"}, exitUsage},
		{"insecure-hub", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", []string{"--hub", "http://evil.example"}, exitUsage},
		// a hostname that merely starts with "127." is NOT loopback — cleartext http must be refused
		{"fake-loopback", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", []string{"--hub", "http://127.evil.example"}, exitUsage},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("TUGRA_MIGRATION_TOKEN", tc.env)
			var stdout, stderr bytes.Buffer
			code := RunCLI(tc.args, "test", &stdout, &stderr)
			if code != tc.want {
				t.Fatalf("exit=%d want %d", code, tc.want)
			}
			assertOneJSONLine(t, stdout.Bytes())
		})
	}
}

func TestRunHandshake(t *testing.T) {
	hs := &hubState{restored: map[string]bool{}}
	srv := httptest.NewServer(hs.handler(t))
	defer srv.Close()
	t.Setenv("TUGRA_MIGRATION_TOKEN", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	var stdout, stderr bytes.Buffer
	code := RunCLI([]string{"--hub", srv.URL, "--handshake"}, "test", &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("handshake exit=%d; stderr: %s", code, stderr.String())
	}
	var out output
	_ = json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out)
	if !out.Handshake || out.RecipesV != 1 || len(out.Engines) != 6 {
		t.Fatalf("handshake output wrong: %+v", out)
	}
}

func TestRunDryRun(t *testing.T) {
	hs := &hubState{restored: map[string]bool{}, status0: "none"}
	srv := httptest.NewServer(hs.handler(t))
	defer srv.Close()
	t.Setenv("TUGRA_MIGRATION_TOKEN", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	var stdout, stderr bytes.Buffer
	code := RunCLI([]string{"--hub", srv.URL, "--dry-run"}, "test", &stdout, &stderr)
	if code != exitOK {
		t.Fatalf("dry-run exit=%d; stderr: %s", code, stderr.String())
	}
	var out output
	_ = json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &out)
	if !out.DryRun || out.Counts.Restored != 0 || out.Items[0].State != "planned" {
		t.Fatalf("dry-run must not report a restore: %+v", out)
	}
}

func TestRunVersionSkew(t *testing.T) {
	// v=2 envelope -> exit 5, nothing dumped.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/probe"):
			io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
		case strings.HasSuffix(r.URL.Path, "/recipes"):
			io.WriteString(w, `{"v":2,"recipes":{},"unsupported":{}}`)
		}
	}))
	defer srv.Close()
	t.Setenv("TUGRA_MIGRATION_TOKEN", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	var stdout, stderr bytes.Buffer
	if code := RunCLI([]string{"--hub", srv.URL}, "test", &stdout, &stderr); code != exitSkew {
		t.Fatalf("v-skew exit=%d want %d; stderr: %s", code, exitSkew, stderr.String())
	}
}

func TestRunStrictDecodeIsSkew(t *testing.T) {
	// a v=1 envelope with an unexpected extra field -> strict decode fails -> exit 5 (skew), NOT 4.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/probe"):
			io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
		case strings.HasSuffix(r.URL.Path, "/recipes"):
			io.WriteString(w, `{"v":1,"recipes":{},"unsupported":{},"surprise":true}`)
		}
	}))
	defer srv.Close()
	t.Setenv("TUGRA_MIGRATION_TOKEN", "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	var stdout, stderr bytes.Buffer
	if code := RunCLI([]string{"--hub", srv.URL}, "test", &stdout, &stderr); code != exitSkew {
		t.Fatalf("strict-decode exit=%d want %d; stderr: %s", code, exitSkew, stderr.String())
	}
}

func assertOneJSONLine(t *testing.T, b []byte) {
	t.Helper()
	trimmed := bytes.TrimRight(b, "\n")
	if len(trimmed) == 0 {
		t.Fatal("stdout is empty; expected one JSON line")
	}
	if bytes.Count(trimmed, []byte("\n")) != 0 {
		t.Fatalf("expected exactly one JSON line, got:\n%s", b)
	}
	if !json.Valid(trimmed) {
		t.Fatalf("stdout is not valid JSON: %s", b)
	}
}
