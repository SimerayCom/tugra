package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/journal"
	"github.com/SimerayCom/tugra/agent/internal/keys"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// fakeHub is a minimal hub: it accepts agent connections, completes the handshake (auth_ok with a real
// ed25519 hub key + the "deploy" capability), signs outbound frames exactly like the hub does, and hands each
// connection to the test so it can send frames and wait for typed replies.
type fakeHub struct {
	t     *testing.T
	priv  ed25519.PrivateKey
	pub   string // base64 SPKI
	url   string
	conns chan *hubConn
	feats chan []string // features advertised in each auth/enroll
}

type hubConn struct {
	c    *websocket.Conn
	ctx  context.Context
	mu   sync.Mutex
	msgs []map[string]any
	cond *sync.Cond
	done chan struct{}
}

func newFakeHub(t *testing.T) *fakeHub {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	h := &fakeHub{t: t, priv: priv, pub: base64.StdEncoding.EncodeToString(der), conns: make(chan *hubConn, 8), feats: make(chan []string, 8)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		c.SetReadLimit(16 << 20)
		ctx := r.Context()
		_ = wsjson.Write(ctx, c, map[string]any{"type": "challenge", "nonce": "n1"})
		var first map[string]any
		if err := wsjson.Read(ctx, c, &first); err != nil {
			return
		}
		var fs []string
		if raw, ok := first["features"].([]any); ok {
			for _, f := range raw {
				fs = append(fs, f.(string))
			}
		}
		h.feats <- fs
		_ = wsjson.Write(ctx, c, map[string]any{"type": "auth_ok", "serverId": "s1", "hubKey": h.pub, "capabilities": []string{"deploy"}})
		hc := &hubConn{c: c, ctx: ctx, done: make(chan struct{})}
		hc.cond = sync.NewCond(&hc.mu)
		h.conns <- hc
		for {
			var m map[string]any
			if err := wsjson.Read(ctx, c, &m); err != nil {
				break
			}
			hc.mu.Lock()
			hc.msgs = append(hc.msgs, m)
			hc.cond.Broadcast()
			hc.mu.Unlock()
		}
		close(hc.done)
		hc.mu.Lock()
		hc.cond.Broadcast()
		hc.mu.Unlock()
	}))
	t.Cleanup(srv.Close)
	h.url = "ws" + strings.TrimPrefix(srv.URL, "http")
	return h
}

func (h *fakeHub) sign(canonical string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(h.priv, []byte(canonical)))
}

func (h *fakeHub) nextConn() *hubConn {
	h.t.Helper()
	select {
	case c := <-h.conns:
		return c
	case <-time.After(10 * time.Second):
		h.t.Fatal("agent did not connect")
		return nil
	}
}

func (hc *hubConn) send(v any) {
	_ = wsjson.Write(hc.ctx, hc.c, v)
}

// command sends a signed command frame (durable or not).
func (h *fakeHub) command(hc *hubConn, reqID, cmd string, timeoutMs int, durable bool) {
	m := map[string]any{"type": "command", "reqId": reqID, "command": cmd, "timeoutMs": timeoutMs, "capability": "deploy",
		"sig": h.sign(protocol.CanonicalCommand(reqID, cmd, timeoutMs, "deploy"))}
	if durable {
		m["durable"] = true
	}
	hc.send(m)
}

func (h *fakeHub) status(hc *hubConn, reqID string) {
	hc.send(map[string]any{"type": "command_status", "reqId": reqID, "sig": h.sign(protocol.CanonicalCommandStatus(reqID))})
}

func (h *fakeHub) cancel(hc *hubConn, reqID string) {
	hc.send(map[string]any{"type": "command_cancel", "reqId": reqID, "sig": h.sign(protocol.CanonicalCommandCancel(reqID))})
}

// waitFor returns the first message of `typ` for `reqId` that arrives after `after` messages (so a second
// result for the same reqId can be awaited), or fails the test.
func (hc *hubConn) waitFor(t *testing.T, typ, reqID string, skip int, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	hc.mu.Lock()
	defer hc.mu.Unlock()
	for {
		seen := 0
		for _, m := range hc.msgs {
			if m["type"] == typ && m["reqId"] == reqID {
				if seen == skip {
					return m
				}
				seen++
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s %s", typ, reqID)
		}
		select {
		case <-hc.done:
			// connection ended: give the final broadcast a chance, then fail if still missing
			for _, m := range hc.msgs {
				if m["type"] == typ && m["reqId"] == reqID {
					return m
				}
			}
			t.Fatalf("connection closed before %s %s", typ, reqID)
		default:
		}
		timer := time.AfterFunc(50*time.Millisecond, func() { hc.mu.Lock(); hc.cond.Broadcast(); hc.mu.Unlock() })
		hc.cond.Wait()
		timer.Stop()
	}
}

func (hc *hubConn) count(typ, reqID string) int {
	hc.mu.Lock()
	defer hc.mu.Unlock()
	n := 0
	for _, m := range hc.msgs {
		if m["type"] == typ && m["reqId"] == reqID {
			n++
		}
	}
	return n
}

// startAgent runs the agent's connect loop (like main.go, without backoff) against the fake hub with a shared
// process-level journal, and returns a stop func.
func startAgent(t *testing.T, h *fakeHub, reg *journal.Registry) (stop func()) {
	t.Helper()
	dir := t.TempDir()
	store, _ := config.LoadStore(filepath.Join(dir, "agent.json"))
	store.ServerID = "s1"
	store.Seal = "seal"
	_ = store.Save()
	cfg := config.Config{HubURL: h.url, Version: "test", Journal: reg, CapsBypass: false}
	kp := keys.New()
	ctx, cancel := context.WithCancel(context.Background())
	doneCh := make(chan struct{})
	go func() {
		defer close(doneCh)
		for ctx.Err() == nil {
			_ = runOnce(ctx, cfg, kp, store, nil, false)
			select {
			case <-ctx.Done():
			case <-time.After(20 * time.Millisecond):
			}
		}
	}()
	return func() {
		cancel()
		<-doneCh
	}
}

func lines(t *testing.T, path string) int {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return len(strings.Split(strings.TrimSpace(string(b)), "\n"))
}

func TestAgentAdvertisesJournalFeature(t *testing.T) {
	h := newFakeHub(t)
	reg := journal.New("")
	stop := startAgent(t, h, reg)
	defer stop()
	_ = h.nextConn()
	fs := <-h.feats
	found := false
	for _, f := range fs {
		if f == protocol.FeatureCmdJournal {
			found = true
		}
	}
	if !found {
		t.Fatalf("auth must advertise %s, got %v", protocol.FeatureCmdJournal, fs)
	}
}

func TestDurableCommandRunsOnceAndReportsState(t *testing.T) {
	h := newFakeHub(t)
	reg := journal.New(t.TempDir())
	stop := startAgent(t, h, reg)
	defer stop()
	hc := h.nextConn()
	marker := filepath.Join(t.TempDir(), "ran")
	cmd := "echo ran >> " + marker + " && echo hi"

	h.command(hc, "r1", cmd, 5000, true)
	res := hc.waitFor(t, "command_result", "r1", 0, 5*time.Second)
	if res["exitCode"].(float64) != 0 || res["output"] != "hi\n" {
		t.Fatalf("result: %v", res)
	}
	// the live log chunk still streams on this connection
	if hc.count("command_log", "r1") == 0 {
		t.Fatal("durable commands still stream command_log")
	}
	// A re-sent durable reqId is NOT re-run: the stored result is re-sent instead.
	h.command(hc, "r1", cmd, 5000, true)
	res2 := hc.waitFor(t, "command_result", "r1", 1, 5*time.Second)
	if res2["exitCode"].(float64) != 0 || res2["output"] != "hi\n" {
		t.Fatalf("re-sent result: %v", res2)
	}
	if n := lines(t, marker); n != 1 {
		t.Fatalf("durable duplicate must not re-run the command: ran %d times", n)
	}
	// command_status → done with the journaled result
	h.status(hc, "r1")
	st := hc.waitFor(t, "command_state", "r1", 0, 5*time.Second)
	if st["state"] != "done" || st["exitCode"].(float64) != 0 || st["output"] != "hi\n" || st["killed"] != nil {
		t.Fatalf("state: %v", st)
	}
	// unknown reqId → unknown (never an error, never a run)
	h.status(hc, "ghost")
	if st := hc.waitFor(t, "command_state", "ghost", 0, 5*time.Second); st["state"] != "unknown" {
		t.Fatalf("ghost state: %v", st)
	}
	// A NON-durable duplicate keeps today's semantics: it runs again.
	h.command(hc, "r2", cmd, 5000, false)
	hc.waitFor(t, "command_result", "r2", 0, 5*time.Second)
	h.command(hc, "r2", cmd, 5000, false)
	hc.waitFor(t, "command_result", "r2", 1, 5*time.Second)
	if n := lines(t, marker); n != 3 {
		t.Fatalf("non-durable duplicate must re-run: ran %d times total", n)
	}
	// an unsigned command_status is rejected (no reply)
	hc.send(map[string]any{"type": "command_status", "reqId": "r1"})
	time.Sleep(150 * time.Millisecond)
	if hc.count("command_state", "r1") != 1 {
		t.Fatal("unsigned command_status must be ignored")
	}
}

func TestDurableCommandSurvivesReconnectAndReportsOnNewConnection(t *testing.T) {
	h := newFakeHub(t)
	reg := journal.New(t.TempDir())
	stop := startAgent(t, h, reg)
	defer stop()
	a := h.nextConn()
	h.command(a, "r3", "sleep 2; echo late", 10000, true)
	// Make sure the agent has started it (its begin is journaled), then drop connection A.
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, d := reg.Status("r3"); d == journal.Running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("command never began")
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = a.c.Close(websocket.StatusGoingAway, "hub restart")
	b := h.nextConn()
	// The command kept running across the drop; the new connection can ask about it...
	h.status(b, "r3")
	st := b.waitFor(t, "command_state", "r3", 0, 5*time.Second)
	if st["state"] != "running" && st["state"] != "done" {
		t.Fatalf("state after reconnect: %v", st)
	}
	// ...and its result arrives HERE, on connection B, with the real output (the reader-exit fast path makes
	// the agent reconnect within milliseconds of the drop, well inside the command's remaining runtime).
	res := b.waitFor(t, "command_result", "r3", 0, 8*time.Second)
	if res["exitCode"].(float64) != 0 || res["output"] != "late\n" {
		t.Fatalf("result on new connection: %v", res)
	}
	h.status(b, "r3")
	st2 := b.waitFor(t, "command_state", "r3", 1, 5*time.Second)
	if st2["state"] != "done" || st2["output"] != "late\n" {
		t.Fatalf("final state: %v", st2)
	}
}

func TestCancelAfterReconnectIsRecordedAsKilled(t *testing.T) {
	h := newFakeHub(t)
	reg := journal.New(t.TempDir())
	stop := startAgent(t, h, reg)
	defer stop()
	a := h.nextConn()
	h.command(a, "r4", "sleep 30", 60000, true)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, d := reg.Status("r4"); d == journal.Running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("command never began")
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = a.c.Close(websocket.StatusGoingAway, "hub restart")
	b := h.nextConn()
	h.cancel(b, "r4") // the cancel targets a command started on the PREVIOUS connection
	res := b.waitFor(t, "command_result", "r4", 0, 10*time.Second)
	if res["exitCode"].(float64) == 0 {
		t.Fatalf("killed command must not report success: %v", res)
	}
	h.status(b, "r4")
	st := b.waitFor(t, "command_state", "r4", 0, 5*time.Second)
	if st["state"] != "done" || st["killed"] != true {
		t.Fatalf("killed must be journaled: %v", st)
	}
}

func TestInterruptedEntryIsReportedNotReRun(t *testing.T) {
	dir := t.TempDir()
	// Simulate an agent that died mid-command: a persisted entry with no finish.
	seed := journal.New(dir)
	seed.Begin("r5", "echo again")
	h := newFakeHub(t)
	reg := journal.New(dir) // "agent restart" loads it as interrupted
	stop := startAgent(t, h, reg)
	defer stop()
	hc := h.nextConn()
	h.status(hc, "r5")
	if st := hc.waitFor(t, "command_state", "r5", 0, 5*time.Second); st["state"] != "interrupted" {
		t.Fatalf("state: %v", st)
	}
	marker := filepath.Join(t.TempDir(), "ran")
	h.command(hc, "r5", "echo x >> "+marker, 5000, true)
	res := hc.waitFor(t, "command_result", "r5", 0, 5*time.Second)
	if res["exitCode"].(float64) != -1 || !strings.Contains(res["output"].(string), "TUGRA_INTERRUPTED") {
		t.Fatalf("re-sent interrupted command must report the interruption, not run: %v", res)
	}
	if lines(t, marker) != 0 {
		t.Fatal("an interrupted durable reqId must never be re-run")
	}
}

func TestAgentShutdownMidCommandJournalsNoVerdict(t *testing.T) {
	dir := t.TempDir()
	h := newFakeHub(t)
	reg := journal.New(dir)
	stop := startAgent(t, h, reg)
	hc := h.nextConn()
	h.command(hc, "r6", "sleep 30", 60000, true)
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, d := reg.Status("r6"); d == journal.Running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("command never began")
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop() // SIGTERM-equivalent: the process ctx is cancelled, the process group is killed
	if _, d := reg.Status("r6"); d != journal.Running {
		t.Fatalf("a shutdown kill must NOT be journaled as a verdict (got %v) — nobody cancelled it", d)
	}
	if hc.count("command_result", "r6") != 0 {
		t.Fatal("no result may be sent for a shutdown-killed command")
	}
	// next agent start: the entry reloads as interrupted → the hub settles it honestly, never as CANCELLED
	if _, d := journal.New(dir).Status("r6"); d != journal.Interrupted {
		t.Fatalf("after restart the entry must be interrupted, got %v", d)
	}
}
