package client

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/coolify"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const (
	cooSSHMaxInFlight = 8                // the per-host maximum the hub may ask for (shared COOLIFY_SSH_LIMITS.perHostMax)
	cooSSHMaxAhead    = 15 * time.Minute // a frame whose exp is further ahead than this is refused
	cooSSHSkew        = 60 * time.Second // clock drift tolerated past exp
	cooSSHOpTimeout   = 10 * time.Minute // one op, whatever exp says
	cooSSHReplayMax   = 1024
)

var (
	cooSSHShaRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
	cooSSHFpRe  = regexp.MustCompile(`^(SHA256:[A-Za-z0-9+/]{43})?$`)
)

// cooSSHRunner is what the gate needs from internal/coolify (a seam so the tests need no docker).
type cooSSHRunner interface {
	Run(ctx context.Context, reqID string, req coolify.Request) protocol.CoolifySSHResult
}

// coolifySSHGate verifies and runs `coolify_ssh_req` frames for ONE connection. Everything attacker-reachable is checked here, fail
// closed, BEFORE docker or ssh is touched: the hub's signature over every field, expiry, replay, the locally held `coolify_ssh`
// capability, and the shape of every field. A frame that fails the signature is dropped silently; one that is signed but refused gets a
// fixed-code result so the hub does not wait out its timeout.
type coolifySSHGate struct {
	hubPub ed25519.PublicKey
	cs     *capState
	send   func(any) error
	now    func() time.Time
	runner cooSSHRunner

	mu   sync.Mutex
	seen map[string]int64
	sem  chan struct{}
}

func newCoolifySSHGate(cfg config.Config, hubPub ed25519.PublicKey, cs *capState, send func(any) error) *coolifySSHGate {
	env := coolify.Env{Image: cfg.AgentImage, HubURL: cfg.HubURL, HubPin: cfg.HubPin}
	// The install points the new agent at the primary endpoint, not at a fallback this session happens to use.
	if cfg.Endpoints != nil {
		if p := cfg.Endpoints.Primary(); p.URL != "" {
			env.HubURL, env.HubPin = p.URL, p.Pin
		}
	}
	return &coolifySSHGate{
		hubPub: hubPub, cs: cs, send: send, now: time.Now, runner: coolify.NewRunner(env),
		seen: map[string]int64{}, sem: make(chan struct{}, cooSSHMaxInFlight),
	}
}

func (g *coolifySSHGate) reply(res protocol.CoolifySSHResult) {
	res.Type = "coolify_ssh_result"
	_ = g.send(res)
}

func (g *coolifySSHGate) refuse(reqID, code string) {
	g.reply(protocol.CoolifySSHResult{ReqID: reqID, OK: false, Code: code})
}

// remember records reqID until exp; false for a duplicate or when the cache is full of live entries (fail closed).
func (g *coolifySSHGate) remember(reqID string, exp, now int64) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.seen) >= cooSSHReplayMax {
		for id, e := range g.seen {
			if e < now {
				delete(g.seen, id)
			}
		}
	}
	if _, dup := g.seen[reqID]; dup || len(g.seen) >= cooSSHReplayMax {
		return false
	}
	g.seen[reqID] = exp
	return true
}

// validate checks the shape of a signed frame. It returns the runner request, or the wire code to refuse with.
func (g *coolifySSHGate) validate(m protocol.ServerMsg) (coolify.Request, string) {
	req := coolify.Request{Op: m.Op, UUID: m.CoolifyServerUUID, UseSudo: m.UseSudo, ExpectedFp: m.ExpectedHostKeyFp, Script: m.Script, Payload: m.Payload}
	if !coolify.ValidUUID(m.CoolifyServerUUID) || !cooSSHFpRe.MatchString(m.ExpectedHostKeyFp) || !cooSSHShaRe.MatchString(m.ScriptSha256) || !cooSSHShaRe.MatchString(m.PayloadSha256) {
		return req, "bad_target"
	}
	if coolify.Sha256Hex(m.Payload) != m.PayloadSha256 {
		return req, "bad_target"
	}
	switch m.Op {
	case "probe", "uninstall":
		// The script is the agent's own copy: the hub names it by hash and cannot supply another.
		if m.Script != "" || m.ScriptSha256 != coolify.ScriptSha256(m.Op) {
			return req, "bad_target"
		}
		if m.Op == "probe" && (m.Payload != "" || m.UseSudo) {
			return req, "bad_target"
		}
	case "install":
		if m.Script == "" || coolify.Sha256Hex(m.Script) != m.ScriptSha256 {
			return req, "bad_target"
		}
		if err := coolify.ValidateInstallInputs(m.Script, m.Payload); err != nil {
			return req, "bad_target"
		}
	default:
		return req, "bad_target"
	}
	return req, ""
}

func (g *coolifySSHGate) handle(ctx context.Context, m protocol.ServerMsg) {
	f := protocol.CoolifySSHFields{
		ReqID: m.ReqID, Op: m.Op, CoolifyServerUUID: m.CoolifyServerUUID, ScriptSha256: m.ScriptSha256, PayloadSha256: m.PayloadSha256,
		UseSudo: m.UseSudo, ExpectedHostKeyFp: m.ExpectedHostKeyFp, Exp: m.Exp, Capability: m.Capability,
	}
	// 1. The hub's signature over every field. Unsigned or forged: dropped silently, like fs2_req.
	if !protocol.VerifySig(g.hubPub, protocol.CanonicalCoolifySSH(f), m.Sig) {
		fmt.Fprintln(os.Stderr, "rejected coolify_ssh_req: invalid or missing hub signature")
		return
	}
	nowT := g.now()
	// 2. Expiry, and a ceiling on how far ahead a frame may be valid.
	if nowT.Unix() > m.Exp+int64(cooSSHSkew.Seconds()) {
		g.refuse(m.ReqID, "timeout")
		return
	}
	if m.Exp > nowT.Add(cooSSHMaxAhead).Unix() {
		g.refuse(m.ReqID, "bad_target")
		return
	}
	// 3. Replay.
	if !g.remember(m.ReqID, m.Exp, nowT.Unix()) {
		g.refuse(m.ReqID, "cancelled")
		return
	}
	// 4. The locally held capability, and the signed one must be it.
	if m.Capability != protocol.CapCoolifySSH || !g.cs.allows(protocol.CapCoolifySSH) {
		fmt.Fprintln(os.Stderr, "rejected coolify_ssh_req: capability not allowed")
		g.refuse(m.ReqID, "cancelled")
		return
	}
	// 5. Shape of every field.
	req, code := g.validate(m)
	if code != "" {
		g.refuse(m.ReqID, code)
		return
	}
	// 6. Concurrency cap, then run on its own goroutine under a deadline that starts now.
	select {
	case g.sem <- struct{}{}:
	default:
		g.refuse(m.ReqID, "timeout")
		return
	}
	d := time.Until(time.Unix(m.Exp, 0).Add(cooSSHSkew))
	if d <= 0 || d > cooSSHOpTimeout {
		d = cooSSHOpTimeout
	}
	opCtx, cancel := context.WithTimeout(ctx, d)
	go func() {
		defer cancel()
		defer func() { <-g.sem }()
		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintln(os.Stderr, "coolify_ssh_req: internal error")
				g.refuse(m.ReqID, "installer_failed")
			}
		}()
		g.reply(g.runner.Run(opCtx, m.ReqID, req))
	}()
}
