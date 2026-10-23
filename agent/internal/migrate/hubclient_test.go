package migrate

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func noSleep(t *testing.T) {
	t.Helper()
	orig := waitRetry
	waitRetry = func(context.Context, time.Duration) error { return nil }
	t.Cleanup(func() { waitRetry = orig })
}

func newTestHub(t *testing.T, srv *httptest.Server) *Hub {
	t.Helper()
	h, err := NewHub(srv.URL, "tugra_mig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "test")
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestProbeAndRecipesStrict(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "" {
			t.Error("missing bearer header")
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/probe"):
			io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
		case strings.HasSuffix(r.URL.Path, "/recipes"):
			spec := engineSpecs["POSTGRES"]
			io.WriteString(w, `{"v":1,"recipes":{"POSTGRES":{"command":`+jsonStr(spec.golden)+`,"format":"pg_custom","pgFormat":"custom","env":[{"name":"PGPASSWORD","from":"pw"}]}},"unsupported":{}}`)
		}
	}))
	defer srv.Close()
	h := newTestHub(t, srv)

	p, err := h.Probe(context.Background())
	if err != nil || !p.OK || p.OpID != "op1" {
		t.Fatalf("probe: %+v %v", p, err)
	}
	env, err := h.Recipes(context.Background())
	if err != nil || env.V != 1 || len(env.Recipes) != 1 {
		t.Fatalf("recipes: %+v %v", env, err)
	}
}

func TestRecipesStrictRejectsUnknownField(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"v":1,"recipes":{},"unsupported":{},"surprise":true}`)
	}))
	defer srv.Close()
	if _, err := newTestHub(t, srv).Recipes(context.Background()); err == nil {
		t.Fatal("an unknown field (without a v bump) must fail closed")
	}
}

func TestRedirectNotFollowedTokenNotLeaked(t *testing.T) {
	var leaked atomic.Bool
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			leaked.Store(true)
		}
	}))
	defer evil.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, evil.URL+"/steal", http.StatusFound)
	}))
	defer srv.Close()

	_, err := newTestHub(t, srv).Probe(context.Background())
	if kindOf(err) != KindRedirect {
		t.Fatalf("expected KindRedirect, got %v", err)
	}
	if leaked.Load() {
		t.Fatal("the bearer token was sent to the redirect target")
	}
}

func TestPutExactContentLengthNotChunked(t *testing.T) {
	body := strings.Repeat("Z", 1234)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength != int64(len(body)) {
			t.Errorf("Content-Length = %d, want %d", r.ContentLength, len(body))
		}
		if len(r.TransferEncoding) > 0 && r.TransferEncoding[0] == "chunked" {
			t.Error("request must not be chunked")
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/octet-stream" {
			t.Errorf("Content-Type = %q", ct)
		}
		got, _ := io.ReadAll(r.Body)
		if string(got) != body {
			t.Error("body mismatch")
		}
		w.WriteHeader(201)
		io.WriteString(w, `{"itemRef":"database:_:x","bytes":1234,"sha256":"abc","gzip":true,"pgFormat":"custom"}`)
	}))
	defer srv.Close()
	h := newTestHub(t, srv)
	resp, err := h.Put(context.Background(), "database:_:x", strings.NewReader(body), int64(len(body)), PutQuery{Gzip: true, Format: "custom"})
	if err != nil || resp.Bytes != 1234 {
		t.Fatalf("put: %+v %v", resp, err)
	}
}

func TestRetryPolicy(t *testing.T) {
	noSleep(t)
	// 429 twice then 200 — retried; Retry-After honored (no panic).
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) <= 2 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(429)
			return
		}
		io.WriteString(w, `{"ok":true,"opId":"op1","expiresAt":"2999-01-01T00:00:00Z"}`)
	}))
	defer srv.Close()
	if _, err := newTestHub(t, srv).Probe(context.Background()); err != nil {
		t.Fatalf("429 should be retried: %v", err)
	}
	if n.Load() != 3 {
		t.Errorf("expected 3 attempts, got %d", n.Load())
	}

	// 500 is NOT retried.
	var m atomic.Int32
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		m.Add(1)
		http.Error(w, `{"message":"boom"}`, 500)
	}))
	defer srv2.Close()
	if _, err := newTestHub(t, srv2).Probe(context.Background()); err == nil {
		t.Fatal("500 should error")
	}
	if m.Load() != 1 {
		t.Errorf("500 must not be retried, got %d attempts", m.Load())
	}
}

func TestAuthAnd409Classification(t *testing.T) {
	noSleep(t)
	// 401 -> KindAuth
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"invalid or expired migration token"}`, 401)
	}))
	defer srv.Close()
	if kindOf(mustErr(newTestHub(t, srv).Probe(context.Background()))) != KindAuth {
		t.Error("401 should be KindAuth")
	}

	table := map[string]ErrKind{
		"a different artifact is already restored — pass resync=1 to overwrite":           KindDifferentRestored,
		"the destination was started or holds data not restored by this migration":        KindDestDirty,
		"a restore is already in progress for this item":                                  KindRestoreInProgress,
		"nothing staged for this item — upload the artifact first":                        KindNotStaged,
		"the hub public URL is not configured — set HUB_PUBLIC_URL to migrate data":       KindHubMisconfig,
		"some brand new conflict nobody classified":                                       KindUnknownConflict,
	}
	for msg, want := range table {
		if got := classify409(msg); got != want {
			t.Errorf("classify409(%q)=%v want %v", msg, got, want)
		}
	}
}

func mustErr(_ any, err error) error { return err }

func jsonStr(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
