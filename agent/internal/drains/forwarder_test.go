package drains

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

func TestBatcherFlushesOnSize(t *testing.T) {
	var got [][]LogLine
	var mu sync.Mutex
	b := NewBatcher(10, 0, time.Hour, func(lines []LogLine) {
		mu.Lock()
		got = append(got, lines)
		mu.Unlock()
	})
	b.Add(LogLine{Message: "12345"})  // 5 bytes
	b.Add(LogLine{Message: "67890a"}) // 11 >= 10 → flush
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || len(got[0]) != 2 {
		t.Fatalf("expected one flush of 2 lines, got %v", got)
	}
}

func TestBatcherFlushEmitsRemainder(t *testing.T) {
	var got [][]LogLine
	b := NewBatcher(1<<20, 0, time.Hour, func(lines []LogLine) { got = append(got, lines) })
	b.Add(LogLine{Message: "x"})
	b.Flush()
	b.Flush() // no-op on empty
	if len(got) != 1 {
		t.Fatalf("expected exactly one flush, got %d", len(got))
	}
}

func TestBatcherFlushesOnLineCount(t *testing.T) {
	var got [][]LogLine
	b := NewBatcher(1<<20, 3, time.Hour, func(lines []LogLine) { got = append(got, lines) }) // cap 3 entries
	b.Add(LogLine{Message: "a"})
	b.Add(LogLine{Message: "b"})
	b.Add(LogLine{Message: "c"}) // 3rd entry → flush
	if len(got) != 1 || len(got[0]) != 3 {
		t.Fatalf("expected one flush of 3 lines, got %v", got)
	}
}

func TestPostBatchSendsJSONAndBearer(t *testing.T) {
	type payload struct {
		Server string    `json:"server"`
		Lines  []LogLine `json:"lines"`
	}
	done := make(chan payload, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("authorization") != "Bearer secret" {
			t.Errorf("missing/invalid bearer: %q", r.Header.Get("authorization"))
		}
		body, _ := io.ReadAll(r.Body)
		var p payload
		_ = json.Unmarshal(body, &p)
		done <- p
		w.WriteHeader(200)
	}))
	defer srv.Close()

	err := postBatch(srv.Client(), "s1", protocol.DrainCfg{Endpoint: srv.URL, Token: "secret"},
		[]LogLine{{Container: "tugra_a", Message: "hello"}})
	if err != nil {
		t.Fatalf("postBatch error: %v", err)
	}
	p := <-done
	if p.Server != "s1" || len(p.Lines) != 1 || p.Lines[0].Container != "tugra_a" || p.Lines[0].Message != "hello" {
		t.Fatalf("unexpected payload: %+v", p)
	}
}

func TestPostBatchUnreachableIsError(t *testing.T) {
	// best-effort: caller ignores the error, but it must not panic
	err := postBatch(&http.Client{Timeout: time.Millisecond}, "s1",
		protocol.DrainCfg{Endpoint: "http://127.0.0.1:0"}, []LogLine{{Message: "x"}})
	if err == nil {
		t.Fatal("expected an error for an unreachable endpoint")
	}
}

func TestFormatHTTPDefault(t *testing.T) {
	now := time.Unix(0, 0)
	for _, typ := range []string{"", "http", "HTTP"} { // empty + legacy uppercase both fall to the http format
		body, h, err := format(protocol.DrainCfg{Type: typ, Token: "t"}, "s1", []LogLine{{Container: "c", Message: "m"}}, now)
		if err != nil {
			t.Fatalf("format(%q): %v", typ, err)
		}
		var p struct {
			Server string    `json:"server"`
			Lines  []LogLine `json:"lines"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if p.Server != "s1" || len(p.Lines) != 1 || p.Lines[0].Message != "m" {
			t.Fatalf("type %q: unexpected body %s", typ, body)
		}
		if h["authorization"] != "Bearer t" {
			t.Fatalf("type %q: missing bearer", typ)
		}
	}
}

func TestFormatLoki(t *testing.T) {
	now := time.Unix(0, 100)
	body, h, err := format(protocol.DrainCfg{Type: "loki", Token: "t"}, "s1",
		[]LogLine{{Container: "a", Message: "m1"}, {Container: "a", Message: "m2"}, {Container: "b", Message: "m3"}}, now)
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	var p struct {
		Streams []struct {
			Stream map[string]string `json:"stream"`
			Values [][2]string       `json:"values"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(p.Streams) != 2 { // grouped by container: a, b
		t.Fatalf("expected 2 streams, got %d: %s", len(p.Streams), body)
	}
	if p.Streams[0].Stream["container"] != "a" || p.Streams[0].Stream["host"] != "s1" || len(p.Streams[0].Values) != 2 {
		t.Fatalf("stream a wrong: %+v", p.Streams[0])
	}
	// timestamps are ns strings, unique + ascending within the stream
	if p.Streams[0].Values[0][0] != "100" || p.Streams[0].Values[1][0] != "101" || p.Streams[0].Values[0][1] != "m1" {
		t.Fatalf("loki values wrong: %+v", p.Streams[0].Values)
	}
	if h["authorization"] != "Bearer t" {
		t.Fatalf("loki: missing bearer")
	}
}

// drainSrv returns a test server whose handler status is decided by the attempt number (1-based).
func drainSrv(t *testing.T, status func(attempt int32) int) (*httptest.Server, *int32) {
	t.Helper()
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status(atomic.AddInt32(&n, 1)))
	}))
	t.Cleanup(srv.Close)
	return srv, &n
}

func TestPostBatchRetriesTransientThenSucceeds(t *testing.T) {
	srv, n := drainSrv(t, func(a int32) int { // first a 503, then 200
		if a == 1 {
			return 503
		}
		return 200
	})
	if err := postBatch(srv.Client(), "s1", protocol.DrainCfg{Endpoint: srv.URL}, []LogLine{{Message: "x"}}); err != nil {
		t.Fatalf("expected success after one retry: %v", err)
	}
	if got := atomic.LoadInt32(n); got != 2 {
		t.Fatalf("expected 2 attempts, got %d", got)
	}
}

func TestPostBatchRetries429(t *testing.T) {
	srv, n := drainSrv(t, func(a int32) int { // 429 (rate limit) is transient → retried
		if a == 1 {
			return 429
		}
		return 202
	})
	if err := postBatch(srv.Client(), "s1", protocol.DrainCfg{Endpoint: srv.URL}, []LogLine{{Message: "x"}}); err != nil {
		t.Fatalf("429 should be retried: %v", err)
	}
	if got := atomic.LoadInt32(n); got != 2 {
		t.Fatalf("expected 2 attempts, got %d", got)
	}
}

func TestPostBatchDoesNotRetryPermanent4xx(t *testing.T) {
	srv, n := drainSrv(t, func(int32) int { return 400 })
	if err := postBatch(srv.Client(), "s1", protocol.DrainCfg{Endpoint: srv.URL}, []LogLine{{Message: "x"}}); err == nil {
		t.Fatal("expected an error for a 400")
	}
	if got := atomic.LoadInt32(n); got != 1 {
		t.Fatalf("a permanent 4xx must be tried exactly once, got %d", got)
	}
}

func TestPostBatchExhaustsRetries(t *testing.T) {
	srv, n := drainSrv(t, func(int32) int { return 500 })
	if err := postBatch(srv.Client(), "s1", protocol.DrainCfg{Endpoint: srv.URL}, []LogLine{{Message: "x"}}); err == nil {
		t.Fatal("expected an error after exhausting retries")
	}
	if got := atomic.LoadInt32(n); got != maxAttempts {
		t.Fatalf("expected %d attempts, got %d", maxAttempts, got)
	}
}

func TestFormatDatadogNoToken(t *testing.T) {
	_, h, err := format(protocol.DrainCfg{Type: "datadog"}, "s1", []LogLine{{Container: "c", Message: "m"}}, time.Unix(0, 0))
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	if _, ok := h["dd-api-key"]; ok {
		t.Fatal("no token → no DD-API-KEY header")
	}
}

func TestFormatDatadog(t *testing.T) {
	body, h, err := format(protocol.DrainCfg{Type: "datadog", Token: "ddkey"}, "s1",
		[]LogLine{{Container: "c", Message: "m"}}, time.Unix(0, 0))
	if err != nil {
		t.Fatalf("format: %v", err)
	}
	var items []map[string]string
	if err := json.Unmarshal(body, &items); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(items) != 1 || items[0]["message"] != "m" || items[0]["hostname"] != "s1" || items[0]["ddtags"] != "container:c" || items[0]["ddsource"] != "tugra" {
		t.Fatalf("datadog item wrong: %+v", items)
	}
	if h["dd-api-key"] != "ddkey" {
		t.Fatalf("datadog: missing DD-API-KEY, got %+v", h)
	}
	if _, hasBearer := h["authorization"]; hasBearer {
		t.Fatalf("datadog must not send a bearer")
	}
}
