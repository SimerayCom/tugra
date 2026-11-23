package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/endpoints"
	"github.com/SimerayCom/tugra/agent/internal/keys"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// hubKeys is one hub signing identity (several fake hub endpoints may share it, as one real hub serves many addresses).
type hubKeys struct {
	priv ed25519.PrivateKey
	spki string
}

func newHubKeys(t *testing.T) hubKeys {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	return hubKeys{priv: priv, spki: base64.StdEncoding.EncodeToString(der)}
}

func (k hubKeys) sign(canonical string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(k.priv, []byte(canonical)))
}

// epHub is a fake hub endpoint. It authenticates any agent as server "s1", optionally proves its identity, optionally
// pushes signed endpoint lists, and records every hub_endpoint_state the agent reports.
type epHub struct {
	t       *testing.T
	keys    hubKeys
	proof   bool                // send a valid hubProof
	badProf bool                // send a hubProof that does not verify
	code    string              // reply with an error carrying this code instead of auth_ok
	push    func(*epHub) []push // frames to send right after auth_ok
	srv     *httptest.Server
	url     string
	states  chan protocol.HubEndpointState
	authed  chan struct{}
	mu      sync.Mutex
	conns   []*websocket.Conn
}

// kill takes the endpoint down: refuses new connections and drops the live ones (hijacked WebSockets are not closed by
// httptest.Server.Close).
func (h *epHub) kill() {
	h.srv.Listener.Close()
	h.mu.Lock()
	for _, c := range h.conns {
		_ = c.Close(websocket.StatusGoingAway, "down")
	}
	h.mu.Unlock()
}

type push struct {
	rev     int64
	list    []endpoints.Endpoint
	signer  *hubKeys // nil = the hub's own key
	forWhom string   // server id bound into the signature ("" = s1)
}

func newEpHub(t *testing.T, k hubKeys) *epHub {
	t.Helper()
	h := &epHub{t: t, keys: k, proof: true, states: make(chan protocol.HubEndpointState, 32), authed: make(chan struct{}, 32)}
	h.srv = httptest.NewServer(http.HandlerFunc(h.serve))
	t.Cleanup(h.srv.Close)
	h.url = "ws" + strings.TrimPrefix(h.srv.URL, "http") + "/agent"
	return h
}

func (h *epHub) serve(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	h.mu.Lock()
	h.conns = append(h.conns, c)
	h.mu.Unlock()
	ctx := r.Context()
	const nonce = "challenge-1"
	_ = wsjson.Write(ctx, c, map[string]any{"type": "challenge", "nonce": nonce})
	var first map[string]any
	if err := wsjson.Read(ctx, c, &first); err != nil {
		return
	}
	if h.code != "" {
		_ = wsjson.Write(ctx, c, map[string]any{"type": "error", "message": h.code, "code": h.code})
		return
	}
	reply := map[string]any{"type": "auth_ok", "serverId": "s1", "hubKey": h.keys.spki, "capabilities": []string{"deploy"}}
	if hn, _ := first["hubNonce"].(string); hn != "" && h.proof {
		reply["hubProof"] = h.keys.sign(protocol.CanonicalHubProof(nonce, hn))
	}
	if h.badProf {
		reply["hubProof"] = h.keys.sign("something else entirely")
	}
	_ = wsjson.Write(ctx, c, reply)
	h.authed <- struct{}{}
	if h.push != nil {
		for _, p := range h.push(h) {
			signer := h.keys
			if p.signer != nil {
				signer = *p.signer
			}
			who := p.forWhom
			if who == "" {
				who = "s1"
			}
			b, _ := json.Marshal(p.list)
			_ = wsjson.Write(ctx, c, map[string]any{
				"type": "hub_endpoints", "rev": p.rev, "endpointsJson": string(b),
				"sig": signer.sign(protocol.CanonicalHubEndpoints(who, p.rev, string(b))),
			})
		}
	}
	for {
		var m protocol.HubEndpointState
		if err := wsjson.Read(ctx, c, &m); err != nil {
			return
		}
		if m.Type == "hub_endpoint_state" {
			h.states <- m
		}
	}
}

func (h *epHub) nextState(t *testing.T) protocol.HubEndpointState {
	t.Helper()
	select {
	case s := <-h.states:
		return s
	case <-time.After(10 * time.Second):
		t.Fatal("no hub_endpoint_state reported")
		return protocol.HubEndpointState{}
	}
}

// pinned returns a store already enrolled as s1 with the hub key pinned (an agent that enrolled earlier).
func pinnedStore(t *testing.T, k hubKeys, proofSeen bool) (*config.Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.json")
	st, _ := config.LoadStore(path)
	st.ServerID, st.Seal, st.HubKey, st.HubProof = "s1", "seal", k.spki, proofSeen
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	return st, path
}

func runBounded(t *testing.T, cfg config.Config, st *config.Store) (error, bool) {
	t.Helper()
	var ready atomic.Bool
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runOnce(ctx, cfg, keys.New(), st, func() { ready.Store(true) }, false) }()
	// A session that handshook keeps running until its context ends; a refusal returns at once.
	select {
	case err := <-done:
		return err, ready.Load()
	case <-time.After(2 * time.Second):
		cancel()
		return <-done, ready.Load()
	}
}

// --- identity: forged / mismatched / missing proof -------------------------------------------------------------

func TestForgedHubListRejectedAndStateUnchanged(t *testing.T) {
	k, evil := newHubKeys(t), newHubKeys(t)
	h := newEpHub(t, k)
	h.push = func(*epHub) []push {
		return []push{
			{rev: 5, list: []endpoints.Endpoint{{URL: "wss://attacker.example.com/agent"}}, signer: &evil},                // wrong key
			{rev: 6, list: []endpoints.Endpoint{{URL: "wss://attacker.example.com/agent"}}, forWhom: "some-other-server"}, // right key, another server's frame
		}
	}
	st, _ := pinnedStore(t, k, true)
	mgr, _ := endpoints.Open("", endpoints.Endpoint{URL: h.url}, true)
	cfg := config.Config{HubURL: h.url, Endpoints: mgr, IsBootstrap: true}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = runOnce(ctx, cfg, keys.New(), st, nil, false) }()

	if s := h.nextState(t); !s.Accepted { // the connect-time report
		t.Fatalf("unexpected first state %+v", s)
	}
	for i, want := range []string{"invalid signature", "invalid signature"} {
		s := h.nextState(t)
		if s.Accepted || s.Error != want {
			t.Fatalf("forged frame %d must be refused (%q), got %+v", i, want, s)
		}
	}
	if mgr.Primary().URL != h.url || mgr.Rev() != 0 {
		t.Fatalf("a forged list changed the endpoints: primary=%v rev=%d", mgr.Primary(), mgr.Rev())
	}
}

func TestSignedListAcceptedAndStaleReplayRefused(t *testing.T) {
	k := newHubKeys(t)
	h := newEpHub(t, k)
	good := []endpoints.Endpoint{{URL: h.url}, {URL: "wss://fallback.example.com/agent"}} // primary = the current one: no switch
	h.push = func(*epHub) []push {
		return []push{{rev: 10, list: good}, {rev: 9, list: []endpoints.Endpoint{{URL: "wss://older.example.com/agent"}}}}
	}
	st, _ := pinnedStore(t, k, true)
	mgr, _ := endpoints.Open("", endpoints.Endpoint{URL: h.url}, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = runOnce(ctx, config.Config{HubURL: h.url, Endpoints: mgr, IsBootstrap: true}, keys.New(), st, nil, false)
	}()
	h.nextState(t)
	if s := h.nextState(t); !s.Accepted || s.Rev != 10 {
		t.Fatalf("a correctly signed list must be accepted: %+v", s)
	}
	if s := h.nextState(t); s.Accepted {
		t.Fatalf("an older rev is a replay and must be refused: %+v", s)
	}
	if got := mgr.Order(); len(got) != 2 || got[1].URL != "wss://fallback.example.com/agent" {
		t.Fatalf("order = %v", got)
	}
}

func TestHubKeyMismatchRefusedUnlessRepinned(t *testing.T) {
	pinned, other := newHubKeys(t), newHubKeys(t)
	h := newEpHub(t, other) // a perfectly valid hub — of a DIFFERENT key
	st, path := pinnedStore(t, pinned, true)
	err, ready := runBounded(t, config.Config{HubURL: h.url}, st)
	if !errors.Is(err, ErrHubKeyMismatch) || ready {
		t.Fatalf("a different hub key must be refused before anything runs: err=%v ready=%v", err, ready)
	}
	if again, _ := config.LoadStore(path); again.HubKey != pinned.spki {
		t.Fatal("a refused endpoint must not replace the pin")
	}
	// The explicit operator action follows a hub whose key really changed.
	if err, ready := runBounded(t, config.Config{HubURL: h.url, RepinHubKey: true}, st); !ready {
		t.Fatalf("TUGRA_HUB_REPIN must accept the new key: %v", err)
	}
	if again, _ := config.LoadStore(path); again.HubKey != other.spki {
		t.Fatal("the new key must be pinned after a repin")
	}
}

func TestHubProofRules(t *testing.T) {
	k := newHubKeys(t)
	t.Run("first contact pins the key (TOFU) and records the proof", func(t *testing.T) {
		h := newEpHub(t, k)
		st, path := pinnedStore(t, k, false)
		st.HubKey = ""
		_ = st.Save()
		if err, ready := runBounded(t, config.Config{HubURL: h.url}, st); !ready {
			t.Fatalf("first handshake failed: %v", err)
		}
		again, _ := config.LoadStore(path)
		if again.HubKey != k.spki || !again.HubProof {
			t.Fatalf("pin/proof not persisted: %+v", again)
		}
	})
	t.Run("an invalid proof is refused", func(t *testing.T) {
		h := newEpHub(t, k)
		h.badProf = true
		st, _ := pinnedStore(t, k, false)
		if err, ready := runBounded(t, config.Config{HubURL: h.url}, st); ready || err == nil || !strings.Contains(err.Error(), "proof is invalid") {
			t.Fatalf("a bad proof must be refused: err=%v ready=%v", err, ready)
		}
	})
	t.Run("once a proof was seen, a hub without one is refused (no downgrade)", func(t *testing.T) {
		h := newEpHub(t, k)
		h.proof = false
		st, _ := pinnedStore(t, k, true)
		if err, ready := runBounded(t, config.Config{HubURL: h.url}, st); ready || err == nil || !strings.Contains(err.Error(), "did not prove") {
			t.Fatalf("expected a missing-proof refusal: err=%v ready=%v", err, ready)
		}
	})
	t.Run("a legacy hub with no proof still works until one was seen", func(t *testing.T) {
		h := newEpHub(t, k)
		h.proof = false
		st, _ := pinnedStore(t, k, false)
		if err, ready := runBounded(t, config.Config{HubURL: h.url}, st); !ready {
			t.Fatalf("back-compat: an older hub must still connect: %v", err)
		}
	})
	t.Run("a hub-pushed endpoint always needs a proof", func(t *testing.T) {
		h := newEpHub(t, k)
		h.proof = false
		st, _ := pinnedStore(t, k, false)
		mgr, _ := endpoints.Open("", endpoints.Endpoint{URL: "wss://install.example.com/agent"}, false)
		cfg := config.Config{HubURL: h.url, Endpoints: mgr, IsBootstrap: false}
		if err, ready := runBounded(t, cfg, st); ready || err == nil {
			t.Fatalf("a learned endpoint without a proof must be refused: err=%v ready=%v", err, ready)
		}
	})
}

func TestLearnedEndpointCannotTriggerReenroll(t *testing.T) {
	k := newHubKeys(t)
	h := newEpHub(t, k)
	h.code = "reenroll"
	st, _ := pinnedStore(t, k, false)
	mgr, _ := endpoints.Open("", endpoints.Endpoint{URL: "wss://install.example.com/agent"}, false)
	learned := config.Config{HubURL: h.url, Token: "tok", Endpoints: mgr, IsBootstrap: false}
	if err, _ := runBounded(t, learned, st); errors.Is(err, errStaleIdentity) {
		t.Fatal("a hub-pushed endpoint must never make the agent resend its enroll token")
	}
	boot := learned
	boot.IsBootstrap = true
	if err, _ := runBounded(t, boot, st); !errors.Is(err, errStaleIdentity) {
		t.Fatalf("the install-time endpoint keeps the reenroll recovery: %v", err)
	}
}

// --- TLS pin ---------------------------------------------------------------------------------------------------

func TestPinnedWSSEndpoint(t *testing.T) {
	k := newHubKeys(t)
	hub := newEpHub(t, k)
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(hub.serve))
	t.Cleanup(tlsSrv.Close)
	url := "wss" + strings.TrimPrefix(tlsSrv.URL, "https") + "/agent"
	good := endpoints.Fingerprint(tlsSrv.Certificate().Raw)

	st, _ := pinnedStore(t, k, false)
	caPath := filepath.Join(t.TempDir(), "hub-cert.pem")
	if err, ready := runBounded(t, config.Config{HubURL: url, HubPin: good, CACertPath: caPath}, st); !ready {
		t.Fatalf("the matching pin must connect: %v", err)
	}
	if b, err := os.ReadFile(caPath); err != nil || !strings.Contains(string(b), "BEGIN CERTIFICATE") {
		t.Fatalf("the verified leaf must be written for curl: %v", err)
	}

	st2, _ := pinnedStore(t, k, false)
	err, ready := runBounded(t, config.Config{HubURL: url, HubPin: "sha256:" + strings.Repeat("11", 32)}, st2)
	if ready || err == nil || !strings.Contains(err.Error(), endpoints.ErrPinMismatch.Error()) {
		t.Fatalf("a pin mismatch must be refused: err=%v ready=%v", err, ready)
	}
	// No pin on an IP-less self-signed endpoint: the system roots refuse the test CA.
	if err, ready := runBounded(t, config.Config{HubURL: url}, pinnedStoreOnly(t, k)); ready || err == nil {
		t.Fatalf("without a pin a self-signed hub must be refused: err=%v ready=%v", err, ready)
	}
}

func pinnedStoreOnly(t *testing.T, k hubKeys) *config.Store {
	st, _ := pinnedStore(t, k, false)
	return st
}

func TestPlainWSRefusedWithoutOptIn(t *testing.T) {
	k := newHubKeys(t)
	st, _ := pinnedStore(t, k, false)
	mgr, _ := endpoints.Open("", endpoints.Endpoint{URL: "ws://203.0.113.9:3000/agent"}, false) // no opt-in
	cfg := config.Config{HubURL: "ws://203.0.113.9:3000/agent", Endpoints: mgr, IsBootstrap: true}
	err, _ := runBounded(t, cfg, st)
	if err == nil || !strings.Contains(err.Error(), "plaintext was not opted into") {
		t.Fatalf("plain ws:// to a public host without --hub-insecure must be refused: %v", err)
	}
}

// --- rotation through the supervisor ---------------------------------------------------------------------------

func TestRotationOrderAndPrimaryFirstAfterEveryDrop(t *testing.T) {
	mgr, _ := endpoints.Open("", endpoints.Endpoint{URL: "wss://boot.example.com/agent"}, false)
	if _, err := mgr.Apply(1, []endpoints.Endpoint{{URL: "wss://primary.example.com/agent"}, {URL: "wss://fallback.example.com/agent"}}); err != nil {
		t.Fatal(err)
	}
	var attempts []string
	ctx, cancel := context.WithCancel(context.Background())
	waits := 0
	run := func(_ context.Context, cfg config.Config, _ *keys.KeyPair, _ *config.Store, onReady func()) error {
		attempts = append(attempts, cfg.HubURL)
		switch len(attempts) {
		case 1: // round 1: primary down
			return errors.New("dial: connection refused")
		case 2: // fallback answers, session later drops
			onReady()
			return errors.New("connection closed by hub")
		case 3: // round 2 must start at the PRIMARY again; it is still down...
			return errors.New("dial: connection refused")
		default: // ...and the fallback is chosen again, then we stop
			onReady()
			cancel()
			return ctx.Err()
		}
	}
	superviseWith(ctx, config.Config{}, keys.New(), &config.Store{}, mgr, run, func(context.Context, time.Duration) { waits++ })
	want := []string{"wss://primary.example.com/agent", "wss://fallback.example.com/agent", "wss://primary.example.com/agent", "wss://fallback.example.com/agent"}
	if strings.Join(attempts, " ") != strings.Join(want, " ") {
		t.Fatalf("attempts = %v\nwant     %v", attempts, want)
	}
}

func TestRotationBacksOffWhenEverythingIsDown(t *testing.T) {
	mgr, _ := endpoints.Open("", endpoints.Endpoint{URL: "wss://a.example.com/agent"}, false)
	_, _ = mgr.Apply(1, []endpoints.Endpoint{{URL: "wss://a.example.com/agent"}, {URL: "wss://b.example.com/agent"}})
	ctx, cancel := context.WithCancel(context.Background())
	var waited []time.Duration
	rounds := 0
	run := func(context.Context, config.Config, *keys.KeyPair, *config.Store, func()) error {
		return errors.New("down")
	}
	wait := func(_ context.Context, d time.Duration) {
		waited = append(waited, d)
		if rounds++; rounds == 8 {
			cancel()
		}
	}
	superviseWith(ctx, config.Config{}, keys.New(), &config.Store{}, mgr, run, wait)
	for i, sec := range []int{1, 2, 4, 8, 16, 30, 30, 30} {
		if waited[i] != time.Duration(sec)*time.Second {
			t.Fatalf("backoff = %v (want 1,2,4,8,16 then capped at 30 seconds)", waited)
		}
	}
}

// Full flow with real sessions: the hub pushes a new primary; the agent moves there first, keeps the old address as a
// fallback and reports the endpoint it is on; when the new primary dies it falls back, and a restart (a fresh Manager
// over the same file) still dials the pushed primary first.
func TestSignedUpdateMovesAgentKeepsFallbackSurvivesRestart(t *testing.T) {
	k := newHubKeys(t)
	oldHub, newHub := newEpHub(t, k), newEpHub(t, k)
	oldHub.push = func(*epHub) []push {
		return []push{{rev: 100, list: []endpoints.Endpoint{{URL: newHub.url}, {URL: oldHub.url}}}}
	}
	st, _ := pinnedStore(t, k, true)
	path := filepath.Join(t.TempDir(), "endpoints.json")
	boot := endpoints.Endpoint{URL: oldHub.url}
	mgr, _ := endpoints.Open(path, boot, true)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Supervise(ctx, config.Config{}, keys.New(), st, mgr)

	// 1) connects to the old address (bootstrap), is told about the new primary...
	if s := oldHub.nextState(t); s.Active != oldHub.url {
		t.Fatalf("first session must be on the bootstrap address: %+v", s)
	}
	if s := oldHub.nextState(t); !s.Accepted || s.Primary != newHub.url {
		t.Fatalf("the signed list must be accepted: %+v", s)
	}
	// 2) ...and moves to it, reporting that this session is on the new primary.
	if s := newHub.nextState(t); s.Active != newHub.url || s.Primary != newHub.url || s.Rev != 100 {
		t.Fatalf("after the switch the agent must report the new endpoint: %+v", s)
	}
	// 3) the new primary goes away: the old address (kept as a fallback) takes over.
	newHub.kill()
	var s endpoints.Endpoint
	deadline := time.After(20 * time.Second)
loop:
	for {
		select {
		case st := <-oldHub.states:
			if st.Active == oldHub.url && st.Primary == newHub.url && st.Rev == 100 {
				s = endpoints.Endpoint{URL: st.Active}
				break loop
			}
		case <-deadline:
			t.Fatal("the agent did not fall back to the old address")
		}
	}
	if s.URL != oldHub.url {
		t.Fatal("fallback session must report the old endpoint")
	}
	// 4) restart: a new Manager over the same file, same install-time --hub, still prefers the pushed primary.
	again, _ := endpoints.Open(path, boot, true)
	if again.Primary().URL != newHub.url || again.Rev() != 100 {
		t.Fatalf("restart lost the pushed list: %v rev=%d", again.Primary(), again.Rev())
	}
}

func TestUnreachableNewPrimaryDoesNotStrandTheAgent(t *testing.T) {
	k := newHubKeys(t)
	hub := newEpHub(t, k)
	dead := "ws://127.0.0.1:1/agent" // nothing listens: connection refused
	hub.push = func(*epHub) []push {
		return []push{{rev: 7, list: []endpoints.Endpoint{{URL: dead}, {URL: hub.url}}}}
	}
	st, _ := pinnedStore(t, k, true)
	mgr, _ := endpoints.Open("", endpoints.Endpoint{URL: hub.url}, true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Supervise(ctx, config.Config{}, keys.New(), st, mgr)
	hub.nextState(t) // first connect
	hub.nextState(t) // list accepted
	// The agent tried the dead primary first, then reconnected to the kept fallback and says so.
	s := hub.nextState(t)
	if s.Active != hub.url || s.Primary != dead {
		t.Fatalf("the agent must stay reachable on the old address: %+v", s)
	}
}

func TestProbeEndpoint(t *testing.T) {
	h := newEpHub(t, newHubKeys(t))
	if !probeEndpoint(context.Background(), endpoints.Endpoint{URL: h.url}) {
		t.Fatal("a live endpoint must probe as reachable")
	}
	if probeEndpoint(context.Background(), endpoints.Endpoint{URL: "ws://127.0.0.1:1/agent"}) {
		t.Fatal("a dead endpoint must not probe as reachable")
	}
	// A pinned endpoint with the wrong certificate is not "the primary is back".
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(h.serve))
	defer tlsSrv.Close()
	u := "wss" + strings.TrimPrefix(tlsSrv.URL, "https") + "/agent"
	if probeEndpoint(context.Background(), endpoints.Endpoint{URL: u, Pin: "sha256:" + strings.Repeat("22", 32)}) {
		t.Fatal("a pin mismatch must not probe as reachable")
	}
	if !probeEndpoint(context.Background(), endpoints.Endpoint{URL: u, Pin: endpoints.Fingerprint(tlsSrv.Certificate().Raw)}) {
		t.Fatal("the right pin must probe as reachable")
	}
}
