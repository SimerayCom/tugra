package xfer

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const goodPath = "/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1800000000&sig=BBBBBBBBBBBBBBBBBBBBBBBB"

func TestOrigin(t *testing.T) {
	for in, want := range map[string]string{
		"ws://hub-api:3000/agent":                  "http://hub-api:3000",
		"wss://hub.example.com/agent":              "https://hub.example.com",
		"wss://u:p@hub.example.com:8443/agent?x=1": "https://hub.example.com:8443",
		"https://hub.example.com/":                 "https://hub.example.com",
		"http://10.0.0.5:3000":                     "http://10.0.0.5:3000",
	} {
		got, err := Origin(in)
		if err != nil || got != want {
			t.Errorf("Origin(%q) = %q,%v want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "ftp://h/x", "ws:///agent", "://x", "hub:3000"} {
		if _, err := Origin(in); err == nil {
			t.Errorf("Origin(%q) accepted", in)
		}
	}
}

func TestValidPath(t *testing.T) {
	if !ValidPath(goodPath) {
		t.Fatal("good path refused")
	}
	for _, p := range []string{
		"", "https://evil.example/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
		"//evil.example" + goodPath, "/api/v1/agent-fs/t/../x?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
		goodPath + "&extra=1", goodPath + "#frag", goodPath + "\r\nHost: evil", goodPath + "\n",
		"/api/v1/agent-fs/t/short?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
		"/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA?sig=BBBBBBBBBBBBBBBBBBBBBBBB&exp=1",
		"/api/v1/agent-fs/t/AAAAAAAAAAAAAAAAAAAAAAAA/x?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
		"/api/v1/other/t/AAAAAAAAAAAAAAAAAAAAAAAA?exp=1&sig=BBBBBBBBBBBBBBBBBBBBBBBB",
		" " + goodPath,
	} {
		if ValidPath(p) {
			t.Errorf("ValidPath(%q) accepted", p)
		}
	}
}

func TestGetOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("no auth header must be sent")
		}
		_, _ = w.Write([]byte("hello"))
	}))
	defer srv.Close()
	rc, err := Get(context.Background(), srv.URL, goodPath, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	if string(b) != "hello" {
		t.Fatalf("%q", b)
	}
}

func TestGetRefusals(t *testing.T) {
	var redirected atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Store(true) }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("exp") {
		case "1800000000":
			http.Redirect(w, r, target.URL, http.StatusFound)
		case "1800000001":
			w.WriteHeader(http.StatusNotFound)
		default:
			_, _ = w.Write([]byte("hello"))
		}
	}))
	defer srv.Close()
	redirect := goodPath
	notFound := strings.Replace(goodPath, "1800000000", "1800000001", 1)
	if _, err := Get(context.Background(), srv.URL, redirect, 5); err == nil {
		t.Fatal("redirect followed")
	}
	if redirected.Load() {
		t.Fatal("redirect target was contacted")
	}
	if _, err := Get(context.Background(), srv.URL, notFound, 5); err == nil {
		t.Fatal("404 accepted")
	}
	other := strings.Replace(goodPath, "1800000000", "1800000002", 1)
	if _, err := Get(context.Background(), srv.URL, other, 6); err == nil {
		t.Fatal("Content-Length mismatch accepted")
	}
	if _, err := Get(context.Background(), srv.URL, "https://evil/x", 5); err == nil {
		t.Fatal("invalid path accepted")
	}
}

func TestGetLyingServerIsBounded(t *testing.T) {
	// A server that sends MORE than it declared is cut at size+1 so the consumer's EOF check can detect it.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "5")
		_, _ = w.Write([]byte("hello-and-more"))
	}))
	defer srv.Close()
	rc, err := Get(context.Background(), srv.URL, goodPath, 5)
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	b, _ := io.ReadAll(rc)
	if len(b) > 6 {
		t.Fatalf("read %d bytes from a size-5 body", len(b))
	}
}

func TestPutOKAndHeaders(t *testing.T) {
	var got []byte
	var cl int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cl = r.ContentLength
		got, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := Put(context.Background(), srv.URL, goodPath, strings.NewReader("12345"), 5); err != nil {
		t.Fatal(err)
	}
	if string(got) != "12345" || cl != 5 {
		t.Fatalf("got %q cl=%d", got, cl)
	}
	// an empty file still sends Content-Length: 0 (not chunked)
	if err := Put(context.Background(), srv.URL, goodPath, strings.NewReader(""), 0); err != nil || cl != 0 {
		t.Fatalf("empty put: %v cl=%d", err, cl)
	}
}

func TestPutRejectedByHub(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	if err := Put(context.Background(), srv.URL, goodPath, strings.NewReader("12345"), 5); err == nil {
		t.Fatal("404 treated as success")
	}
}

func TestPutShortProducerFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := Put(context.Background(), srv.URL, goodPath, strings.NewReader("123"), 5); err == nil {
		t.Fatal("a body shorter than Content-Length must fail the request")
	}
}

func TestPutFromAbortsOnProducerFailure(t *testing.T) {
	aborted := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.Copy(io.Discard, r.Body)
		if err != nil {
			close(aborted) // the hub saw a broken body, NOT a clean end
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	boom := errors.New("helper failed")
	var producerCtx context.Context
	err := PutFrom(context.Background(), srv.URL, goodPath, 10, func(ctx context.Context, w io.Writer) error {
		producerCtx = ctx
		_, _ = w.Write([]byte("abc"))
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the producer error", err)
	}
	select {
	case <-aborted:
	case <-time.After(3 * time.Second):
		t.Fatal("hub never saw the aborted body")
	}
	if producerCtx.Err() == nil {
		t.Fatal("producer context must be cancelled so the helper container is reaped")
	}
}

func TestPutFromHappyPath(t *testing.T) {
	var got []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	err := PutFrom(context.Background(), srv.URL, goodPath, 6, func(_ context.Context, w io.Writer) error {
		_, e := w.Write([]byte("abcdef"))
		return e
	})
	if err != nil || string(got) != "abcdef" {
		t.Fatalf("%v %q", err, got)
	}
}

func TestPutFromHubRejectUnblocksProducer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound) // answers without reading the body
	}))
	defer srv.Close()
	done := make(chan error, 1)
	go func() {
		done <- PutFrom(context.Background(), srv.URL, goodPath, 1<<20, func(ctx context.Context, w io.Writer) error {
			buf := make([]byte, 1<<20)
			_, e := w.Write(buf)
			return e
		})
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("producer stayed blocked after the hub rejected the transfer")
	}
}
