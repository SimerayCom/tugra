package client

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/coolify"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	cTok  = "tugra_en_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
	cUUID = "abc123def456ghi789jkl012"
	cCID  = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	cBody = "tugra_install_main() {\necho hi\n}\ntugra_install_main \"$@\" </dev/null\necho TUGRA_INSTALL_OK\n"
)

type fakeRunner struct {
	mu    sync.Mutex
	calls []coolify.Request
	block chan struct{}
}

func (f *fakeRunner) Run(ctx context.Context, reqID string, req coolify.Request) protocol.CoolifySSHResult {
	f.mu.Lock()
	f.calls = append(f.calls, req)
	f.mu.Unlock()
	if f.block != nil {
		select {
		case <-f.block:
		case <-ctx.Done():
		}
	}
	return protocol.CoolifySSHResult{Type: "coolify_ssh_result", ReqID: reqID, OK: true, Code: "ok_installed"}
}

func (f *fakeRunner) n() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

type cooHarness struct {
	g       *coolifySSHGate
	priv    ed25519.PrivateKey
	run     *fakeRunner
	replies chan protocol.CoolifySSHResult
	now     time.Time
}

func newCooHarness(t *testing.T, caps []string) *cooHarness {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	h := &cooHarness{priv: priv, run: &fakeRunner{}, replies: make(chan protocol.CoolifySSHResult, 32), now: time.Unix(1_700_000_000, 0)}
	h.g = newCoolifySSHGate(config.Config{HubURL: "wss://hub.example.com/agent", AgentImage: "ghcr.io/x/tugra-agent:1"}, pub, newCapState(caps, false), func(v any) error {
		h.replies <- v.(protocol.CoolifySSHResult)
		return nil
	})
	h.g.now = func() time.Time { return h.now }
	h.g.runner = h.run
	return h
}

func (h *cooHarness) probeMsg(id string) protocol.ServerMsg {
	return protocol.ServerMsg{
		Type: "coolify_ssh_req", ReqID: id, Op: "probe", CoolifyServerUUID: cUUID, ScriptSha256: coolify.ScriptSha256("probe"),
		PayloadSha256: coolify.Sha256Hex(""), Exp: h.now.Unix() + 300, Capability: "coolify_ssh",
	}
}

func (h *cooHarness) sign(m protocol.ServerMsg) protocol.ServerMsg {
	f := protocol.CoolifySSHFields{ReqID: m.ReqID, Op: m.Op, CoolifyServerUUID: m.CoolifyServerUUID, ScriptSha256: m.ScriptSha256, PayloadSha256: m.PayloadSha256, UseSudo: m.UseSudo, ExpectedHostKeyFp: m.ExpectedHostKeyFp, Exp: m.Exp, Capability: m.Capability}
	m.Sig = base64.StdEncoding.EncodeToString(ed25519.Sign(h.priv, []byte(protocol.CanonicalCoolifySSH(f))))
	return m
}

func (h *cooHarness) installMsg(id string) protocol.ServerMsg {
	return protocol.ServerMsg{
		Type: "coolify_ssh_req", ReqID: id, Op: "install", CoolifyServerUUID: cUUID, ScriptSha256: coolify.Sha256Hex(cBody), Script: cBody,
		PayloadSha256: coolify.Sha256Hex(cTok), Payload: cTok, UseSudo: true, Exp: h.now.Unix() + 300, Capability: "coolify_ssh",
	}
}

func (h *cooHarness) wait(t *testing.T) protocol.CoolifySSHResult {
	t.Helper()
	select {
	case r := <-h.replies:
		return r
	case <-time.After(3 * time.Second):
		t.Fatal("no reply")
	}
	return protocol.CoolifySSHResult{}
}

func (h *cooHarness) silent(t *testing.T) {
	t.Helper()
	select {
	case r := <-h.replies:
		t.Fatalf("unexpected reply %+v", r)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestCoolifySSHRunsASignedProbe(t *testing.T) {
	h := newCooHarness(t, []string{"coolify_ssh"})
	h.g.handle(context.Background(), h.sign(h.probeMsg("p1")))
	if r := h.wait(t); !r.OK || r.ReqID != "p1" || h.run.n() != 1 {
		t.Fatalf("%+v", r)
	}
}

func TestCoolifySSHDropsAnUnsignedOrForgedFrameWithoutAnyReply(t *testing.T) {
	h := newCooHarness(t, []string{"coolify_ssh"})
	m := h.probeMsg("p1")
	h.g.handle(context.Background(), m) // no signature
	m.Sig = "AAAA"
	h.g.handle(context.Background(), m)
	_, other, _ := ed25519.GenerateKey(nil)
	h2 := &cooHarness{priv: other, now: h.now}
	h.g.handle(context.Background(), h2.sign(m)) // signed by someone else
	h.silent(t)
	if h.run.n() != 0 {
		t.Fatal("ran an unsigned frame")
	}
}

func TestCoolifySSHSignatureCoversEveryField(t *testing.T) {
	h := newCooHarness(t, []string{"coolify_ssh"})
	for name, mut := range map[string]func(*protocol.ServerMsg){
		"reqId":    func(m *protocol.ServerMsg) { m.ReqID = "p2" },
		"op":       func(m *protocol.ServerMsg) { m.Op = "uninstall" },
		"uuid":     func(m *protocol.ServerMsg) { m.CoolifyServerUUID = "zzz123def456ghi789jkl012" },
		"script":   func(m *protocol.ServerMsg) { m.ScriptSha256 = strings.Repeat("0", 64) },
		"payload":  func(m *protocol.ServerMsg) { m.PayloadSha256 = strings.Repeat("0", 64) },
		"sudo":     func(m *protocol.ServerMsg) { m.UseSudo = true },
		"expected": func(m *protocol.ServerMsg) { m.ExpectedHostKeyFp = "SHA256:" + strings.Repeat("A", 43) },
		"exp":      func(m *protocol.ServerMsg) { m.Exp += 1 },
		"cap":      func(m *protocol.ServerMsg) { m.Capability = "coolify_secrets" },
	} {
		m := h.sign(h.probeMsg("p1"))
		mut(&m)
		h.g.handle(context.Background(), m)
		h.silent(t)
		if h.run.n() != 0 {
			t.Fatalf("%s: tampered frame ran", name)
		}
	}
}

func TestCoolifySSHRefusesWithoutTheLocalCapability(t *testing.T) {
	h := newCooHarness(t, []string{"deploy", "files"}) // coolify_ssh not granted
	h.g.handle(context.Background(), h.sign(h.probeMsg("p1")))
	if r := h.wait(t); r.OK || r.Code != "cancelled" || h.run.n() != 0 {
		t.Fatalf("%+v", r)
	}
	// and the signed capability must be coolify_ssh even when another one is held
	h = newCooHarness(t, []string{"coolify_ssh", "migrate"})
	m := h.probeMsg("p2")
	m.Capability = "migrate"
	h.g.handle(context.Background(), h.sign(m))
	if r := h.wait(t); r.OK || h.run.n() != 0 {
		t.Fatalf("%+v", r)
	}
}

func TestCoolifySSHExpiryReplayAndHorizon(t *testing.T) {
	h := newCooHarness(t, []string{"coolify_ssh"})
	old := h.probeMsg("old")
	old.Exp = h.now.Unix() - 120
	h.g.handle(context.Background(), h.sign(old))
	if r := h.wait(t); r.OK || r.Code != "timeout" {
		t.Fatalf("expired: %+v", r)
	}
	far := h.probeMsg("far")
	far.Exp = h.now.Unix() + 3600
	h.g.handle(context.Background(), h.sign(far))
	if r := h.wait(t); r.OK || r.Code != "bad_target" {
		t.Fatalf("too far ahead: %+v", r)
	}
	m := h.sign(h.probeMsg("once"))
	h.g.handle(context.Background(), m)
	h.wait(t)
	h.g.handle(context.Background(), m)
	if r := h.wait(t); r.OK || r.Code != "cancelled" || h.run.n() != 1 {
		t.Fatalf("replay: %+v n=%d", r, h.run.n())
	}
}

func TestCoolifySSHFieldValidation(t *testing.T) {
	h := newCooHarness(t, []string{"coolify_ssh"})
	cases := map[string]func(*protocol.ServerMsg){
		"option-like uuid":        func(m *protocol.ServerMsg) { m.CoolifyServerUUID = "-oProxyCommand=id" },
		"unknown op":              func(m *protocol.ServerMsg) { m.Op = "shell" },
		"hub supplied probe body": func(m *protocol.ServerMsg) { m.Script = "id"; m.ScriptSha256 = coolify.Sha256Hex("id") },
		"another probe hash":      func(m *protocol.ServerMsg) { m.ScriptSha256 = strings.Repeat("a", 64) },
		"probe with sudo":         func(m *protocol.ServerMsg) { m.UseSudo = true },
		"bad fingerprint":         func(m *protocol.ServerMsg) { m.ExpectedHostKeyFp = "MD5:aa" },
		"payload hash mismatch":   func(m *protocol.ServerMsg) { m.Payload = "x" },
	}
	for name, mut := range cases {
		m := h.probeMsg("v-" + strings.ReplaceAll(name, " ", "-"))
		mut(&m)
		h.g.handle(context.Background(), h.sign(m))
		if r := h.wait(t); r.OK || r.Code != "bad_target" {
			t.Errorf("%s: %+v", name, r)
		}
	}
	if h.run.n() != 0 {
		t.Fatal("an invalid frame reached the runner")
	}
}

func TestCoolifySSHInstallBindsScriptAndTokenByHash(t *testing.T) {
	h := newCooHarness(t, []string{"coolify_ssh"})
	h.g.handle(context.Background(), h.sign(h.installMsg("i1")))
	if r := h.wait(t); !r.OK {
		t.Fatalf("%+v", r)
	}
	c := h.run.calls[0]
	if c.Op != "install" || c.Payload != cTok || !c.UseSudo || c.Script != cBody {
		t.Fatalf("%+v", c)
	}
	// a swapped script or token fails the signed hash
	bad := h.installMsg("i2")
	bad.Script = cBody + "echo pwned\n"
	h.g.handle(context.Background(), h.sign(bad))
	if r := h.wait(t); r.OK || r.Code != "bad_target" {
		t.Fatalf("%+v", r)
	}
	bad = h.installMsg("i3")
	bad.Payload = "tugra_en_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"
	h.g.handle(context.Background(), h.sign(bad))
	if r := h.wait(t); r.OK || r.Code != "bad_target" {
		t.Fatalf("%+v", r)
	}
	if h.run.n() != 1 {
		t.Fatal("only the intact install may run")
	}
}

func TestCoolifySSHUninstallNeedsAContainerIdAndTheAgentsOwnScript(t *testing.T) {
	h := newCooHarness(t, []string{"coolify_ssh"})
	m := protocol.ServerMsg{Type: "coolify_ssh_req", ReqID: "u1", Op: "uninstall", CoolifyServerUUID: cUUID, ScriptSha256: coolify.ScriptSha256("uninstall"), Payload: cCID, PayloadSha256: coolify.Sha256Hex(cCID), Exp: h.now.Unix() + 300, Capability: "coolify_ssh"}
	h.g.handle(context.Background(), h.sign(m))
	if r := h.wait(t); !r.OK || h.run.calls[0].Payload != cCID {
		t.Fatalf("%+v", r)
	}
	m.ReqID = "u2"
	m.ScriptSha256 = coolify.ScriptSha256("probe")
	h.g.handle(context.Background(), h.sign(m))
	if r := h.wait(t); r.OK || r.Code != "bad_target" {
		t.Fatalf("an uninstall must run the uninstall script only: %+v", r)
	}
}

func TestCoolifySSHConcurrencyCap(t *testing.T) {
	h := newCooHarness(t, []string{"coolify_ssh"})
	h.run.block = make(chan struct{})
	for i := 0; i < cooSSHMaxInFlight; i++ {
		h.g.handle(context.Background(), h.sign(h.probeMsg("c"+string(rune('a'+i)))))
	}
	deadline := time.Now().Add(2 * time.Second)
	for h.run.n() < cooSSHMaxInFlight && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	h.g.handle(context.Background(), h.sign(h.probeMsg("over")))
	if r := h.wait(t); r.OK || r.ReqID != "over" || r.Code != "timeout" {
		t.Fatalf("the ninth request must be refused: %+v", r)
	}
	close(h.run.block)
	for i := 0; i < cooSSHMaxInFlight; i++ {
		h.wait(t)
	}
}

func TestCoolifySSHAdvertisedAndNamed(t *testing.T) {
	found := false
	for _, f := range protocol.Features {
		if f == "coolify_ssh_v1" {
			found = true
		}
	}
	if !found || protocol.CapCoolifySSH != "coolify_ssh" {
		t.Fatal("feature flag and capability names")
	}
}
