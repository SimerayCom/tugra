package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/journal"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

type fakeFwd struct {
	legacy [][]protocol.DrainCfg
	v2     [][]protocol.DrainCfg
}

func (f *fakeFwd) SetDrains(_ context.Context, d []protocol.DrainCfg)   { f.legacy = append(f.legacy, d) }
func (f *fakeFwd) SetDrainsV2(_ context.Context, d []protocol.DrainCfg) { f.v2 = append(f.v2, d) }

type dfEnv struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
	caps *capState
	fwd  *fakeFwd
	df   *drainFrames
	logs []string
}

func newDFEnv(t *testing.T) *dfEnv {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	e := &dfEnv{priv: priv, pub: pub, caps: newCapState([]string{"logs"}, false), fwd: &fakeFwd{}}
	e.df = newDrainFrames(pub, "srv-own", e.caps.allows, e.fwd)
	e.df.logf = func(format string, args ...any) { e.logs = append(e.logs, format) }
	return e
}

func (e *dfEnv) frame(serverID string, rev int64, drains []protocol.DrainCfg, capability string) protocol.ServerMsg {
	b, _ := json.Marshal(drains)
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(e.priv, []byte(protocol.CanonicalLogDrains(serverID, rev, string(b), capability))))
	return protocol.ServerMsg{Type: "log_drains_v2", ServerID: serverID, Rev: rev, DrainsJSON: string(b), Capability: capability, Sig: sig}
}

var oneDrain = []protocol.DrainCfg{{ID: "d1", Type: "http", Endpoint: "https://x", Scope: "app", Match: &protocol.DrainMatch{Prefixes: []string{"tugra_a-"}}, Egress: "public"}}

func TestV2AcceptedAppliesFullSet(t *testing.T) {
	e := newDFEnv(t)
	e.df.handleV2(context.Background(), e.frame("srv-own", 10, oneDrain, "logs"))
	if len(e.fwd.v2) != 1 || len(e.fwd.v2[0]) != 1 || e.fwd.v2[0][0].ID != "d1" || e.fwd.v2[0][0].Scope != "app" || !e.df.v2Active || e.df.lastRev != 10 {
		t.Fatalf("v2 frame not applied: %+v active=%v", e.fwd.v2, e.df.v2Active)
	}
}

func TestV2RejectsBadSignatureWrongServerWrongCapAndStaleRev(t *testing.T) {
	e := newDFEnv(t)
	ctx := context.Background()

	bad := e.frame("srv-own", 10, oneDrain, "logs")
	bad.Sig = base64.StdEncoding.EncodeToString([]byte("not-a-real-signature-0123456789012345678901234567890123456789012345"))
	e.df.handleV2(ctx, bad)
	unsigned := e.frame("srv-own", 11, oneDrain, "logs")
	unsigned.Sig = ""
	e.df.handleV2(ctx, unsigned)
	// tampered payload: signature no longer matches the drainsJson
	tampered := e.frame("srv-own", 12, oneDrain, "logs")
	tampered.DrainsJSON = strings.Replace(tampered.DrainsJSON, "tugra_a-", "tugra_", 1)
	e.df.handleV2(ctx, tampered)
	// a frame captured for ANOTHER server (the hub key is fleet-wide) never verifies against our own id
	e.df.handleV2(ctx, e.frame("srv-other", 13, oneDrain, "logs"))
	// the frame itself claims serverId srv-own but was signed for srv-other: m.ServerID is never trusted
	replay := e.frame("srv-other", 14, oneDrain, "logs")
	replay.ServerID = "srv-own"
	e.df.handleV2(ctx, replay)
	// capability other than logs (signed correctly) is rejected
	e.df.handleV2(ctx, e.frame("srv-own", 15, oneDrain, "deploy"))
	if len(e.fwd.v2) != 0 || e.df.v2Active {
		t.Fatalf("no forged frame may apply: %+v", e.fwd.v2)
	}
	if len(e.logs) != 6 {
		t.Fatalf("every rejection logs one line, got %d: %v", len(e.logs), e.logs)
	}

	// logs not allowed locally (revoked) -> rejected even with a valid signature
	e.caps.set([]string{"deploy"})
	e.df.handleV2(ctx, e.frame("srv-own", 20, oneDrain, "logs"))
	if len(e.fwd.v2) != 0 {
		t.Fatal("a v2 frame must be rejected while `logs` is not allowed")
	}
	e.caps.set([]string{"logs"})

	// stale / replayed rev: accepted once, then <= lastRev is dropped and the previous set kept
	e.df.handleV2(ctx, e.frame("srv-own", 30, oneDrain, "logs"))
	e.df.handleV2(ctx, e.frame("srv-own", 30, nil, "logs")) // same rev (replay) with an empty set
	e.df.handleV2(ctx, e.frame("srv-own", 29, nil, "logs")) // older rev
	if len(e.fwd.v2) != 1 || len(e.fwd.v2[0]) != 1 {
		t.Fatalf("stale revs must not override the accepted set: %+v", e.fwd.v2)
	}
	e.df.handleV2(ctx, e.frame("srv-own", 31, nil, "logs")) // a newer EMPTY set is legitimate: stop everything
	if len(e.fwd.v2) != 2 || len(e.fwd.v2[1]) != 0 {
		t.Fatalf("a newer empty set must apply: %+v", e.fwd.v2)
	}
}

func TestLegacyFrameAfterV2IsIgnored(t *testing.T) {
	e := newDFEnv(t)
	ctx := context.Background()
	legacy := protocol.ServerMsg{Type: "log_drains", Drains: []protocol.DrainCfg{{ID: "old", Type: "http", Endpoint: "https://old"}}}
	e.df.handleLegacy(ctx, legacy) // before any v2 frame: an old hub, still accepted
	if len(e.fwd.legacy) != 1 {
		t.Fatal("legacy frames from an old hub must keep working")
	}
	e.df.handleV2(ctx, e.frame("srv-own", 5, oneDrain, "logs"))
	e.df.handleLegacy(ctx, legacy) // an unsigned frame can never override a signed set
	if len(e.fwd.legacy) != 1 {
		t.Fatal("a legacy frame must be ignored once a v2 frame was accepted")
	}
}

func TestLegacyFrameIsSanitised(t *testing.T) {
	e := newDFEnv(t)
	e.df.handleLegacy(context.Background(), protocol.ServerMsg{Type: "log_drains", Drains: []protocol.DrainCfg{
		{ID: "ok", Type: "loki", Endpoint: "https://l", Token: "t", Scope: "app", Match: &protocol.DrainMatch{Names: []string{"x"}}, Egress: "any", Host: "h"},
		{ID: "legacy-upper", Type: "HTTP", Endpoint: "https://h"},
		{ID: "empty-type", Endpoint: "https://e"},
		{ID: "syslog", Type: "syslog", Endpoint: "h:514", Options: &protocol.DrainOptions{Proto: "udp"}},
		{ID: "fluentd", Type: "fluentd", Endpoint: "h:24224"},
	}})
	got := e.fwd.legacy[0]
	if len(got) != 3 {
		t.Fatalf("NET types must be dropped from a legacy frame: %+v", got)
	}
	// only the four legacy fields survive: no scope/match/egress/host/options can ride an unsigned frame
	if got[0] != (protocol.DrainCfg{ID: "ok", Type: "loki", Endpoint: "https://l", Token: "t"}) {
		t.Fatalf("legacy drain not stripped: %+v", got[0])
	}
}

func TestCapabilitiesWithoutLogsClearsV2Sinks(t *testing.T) {
	e := newDFEnv(t)
	ctx := context.Background()
	e.df.handleV2(ctx, e.frame("srv-own", 1, oneDrain, "logs"))
	e.caps.set([]string{"logs", "deploy"})
	e.df.capabilitiesChanged(ctx)
	if len(e.fwd.v2) != 1 {
		t.Fatal("a capability push that keeps `logs` must not touch the sinks")
	}
	e.caps.set([]string{"deploy"}) // logs revoked
	e.df.capabilitiesChanged(ctx)
	if len(e.fwd.v2) != 2 || e.fwd.v2[1] != nil {
		t.Fatalf("revoking `logs` must clear every v2 sink: %+v", e.fwd.v2)
	}
	// re-grant: the hub re-pushes with a HIGHER rev and it is accepted again
	e.caps.set([]string{"logs"})
	e.df.handleV2(ctx, e.frame("srv-own", 2, oneDrain, "logs"))
	if len(e.fwd.v2) != 3 || len(e.fwd.v2[2]) != 1 {
		t.Fatalf("re-grant must restore the drains: %+v", e.fwd.v2)
	}
	// a legacy frame still cannot take over after the clear
	e.caps.set([]string{"deploy"})
	e.df.capabilitiesChanged(ctx)
	e.df.handleLegacy(ctx, protocol.ServerMsg{Type: "log_drains", Drains: []protocol.DrainCfg{{ID: "x", Type: "http", Endpoint: "https://x"}}})
	if len(e.fwd.legacy) != 0 {
		t.Fatal("v2Active stays true after a capability clear: legacy frames remain ignored")
	}
}

func TestV2MalformedDrainsJSONRejected(t *testing.T) {
	e := newDFEnv(t)
	body := "{not json"
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(e.priv, []byte(protocol.CanonicalLogDrains("srv-own", 1, body, "logs"))))
	e.df.handleV2(context.Background(), protocol.ServerMsg{Type: "log_drains_v2", Rev: 1, DrainsJSON: body, Capability: "logs", Sig: sig})
	if len(e.fwd.v2) != 0 || e.df.lastRev != 0 || e.df.v2Active {
		t.Fatal("a signed but malformed payload must not apply or advance the rev")
	}
}

func TestAgentAdvertisesLogDrainsFeatures(t *testing.T) {
	h := newFakeHub(t)
	stop := startAgent(t, h, journal.New(""))
	defer stop()
	_ = h.nextConn()
	select {
	case fs := <-h.feats:
		have := map[string]bool{}
		for _, f := range fs {
			have[f] = true
		}
		for _, want := range []string{protocol.FeatureLogDrainsV2, protocol.FeatureDrainSyslog, protocol.FeatureDrainGelf, protocol.FeatureDrainFluentd} {
			if !have[want] {
				t.Fatalf("auth must advertise %s, got %v", want, fs)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no features")
	}
}
