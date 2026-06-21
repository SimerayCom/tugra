package drains

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/mrcandev/tugra/agent/internal/protocol"
)

func TestBatcherFlushesOnSize(t *testing.T) {
	var got [][]LogLine
	var mu sync.Mutex
	b := NewBatcher(10, time.Hour, func(lines []LogLine) {
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
	b := NewBatcher(1<<20, time.Hour, func(lines []LogLine) { got = append(got, lines) })
	b.Add(LogLine{Message: "x"})
	b.Flush()
	b.Flush() // no-op on empty
	if len(got) != 1 {
		t.Fatalf("expected exactly one flush, got %d", len(got))
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
