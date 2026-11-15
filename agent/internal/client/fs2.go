package client

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
	"github.com/SimerayCom/tugra/agent/internal/xfer"
)

const (
	fs2DefaultTimeout = 30 * time.Second
	fs2MinTimeout     = 5 * time.Second
	fs2MaxTimeout     = 10 * time.Minute // matches the web proxy's 600s ceiling
	fs2MaxInFlight    = 4                // process-wide concurrent fs2 ops
	fs2SemWait        = 2 * time.Second  // how long an op waits for a slot before `busy`
	fs2ReplayMax      = 4096             // replay-cache bound
)

// fs2State is the process-level state shared by every connection: the replay cache, the concurrency semaphore and
// the per-volume write locks. It survives a reconnect (a signed frame captured before a drop cannot be replayed on
// the next socket); an agent restart clears it, bounded by the request's own `exp`.
type fs2State struct {
	mu       sync.Mutex
	seen     map[string]int64 // reqId -> exp (unix s)
	sem      chan struct{}
	volLocks map[string]chan struct{}
}

func newFs2State() *fs2State {
	return &fs2State{
		seen:     map[string]int64{},
		sem:      make(chan struct{}, fs2MaxInFlight),
		volLocks: map[string]chan struct{}{},
	}
}

var defaultFs2State = newFs2State()

// remember records reqId until exp. It refuses (false) a duplicate or, when the cache is full of unexpired
// entries, anything new (fail closed).
func (s *fs2State) remember(reqID string, exp, now int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.seen) >= fs2ReplayMax {
		for id, e := range s.seen {
			if e < now {
				delete(s.seen, id)
			}
		}
	}
	if _, dup := s.seen[reqID]; dup {
		return false
	}
	if len(s.seen) >= fs2ReplayMax {
		return false
	}
	s.seen[reqID] = exp
	return true
}

// volLock returns the single-slot lock of one volume (created on first use).
func (s *fs2State) volLock(volume string) chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.volLocks[volume]
	if !ok {
		l = make(chan struct{}, 1)
		s.volLocks[volume] = l
	}
	return l
}

// containerFs2 is the container-scope executor; the container-filesystem slice wires it to the ctrfs driver. nil
// means "not available" and the gate answers `unsupported`.
var containerFs2 fs2ContainerFn

// fs2ContainerFn executes one container-scope request (set by the container-FS driver). nil = not available.
type fs2ContainerFn func(ctx context.Context, m protocol.ServerMsg, g *fs2Gate) protocol.Fs2Result

// fs2Gate verifies and runs `fs2_req` messages for ONE connection. Everything attacker-reachable is checked
// here, fail closed, BEFORE any resource is taken or any process launched. The hub enforces the same matrix up
// front; this is the agent-side re-derivation, so a compromised or buggy hub still cannot reach a mutating op
// without a locally granted capability set.
type fs2Gate struct {
	cfg    config.Config
	hubPub ed25519.PublicKey
	cs     *capState
	send   func(any) error
	state  *fs2State
	now    func() time.Time

	semWait time.Duration

	// seams (tests replace them; production wiring is in newFs2Gate)
	launch    func(ctx context.Context, image, volume string, r fsd.Req2, stdin io.Reader, stdout io.Writer) (fsd.Result2, error)
	get       func(ctx context.Context, origin, path string, size int64) (io.ReadCloser, error)
	putFrom   func(ctx context.Context, origin, path string, size int64, produce func(context.Context, io.Writer) error) error
	container fs2ContainerFn
}

func newFs2Gate(cfg config.Config, hubPub ed25519.PublicKey, cs *capState, send func(any) error) *fs2Gate {
	return &fs2Gate{
		cfg: cfg, hubPub: hubPub, cs: cs, send: send,
		state:     defaultFs2State,
		now:       time.Now,
		semWait:   fs2SemWait,
		launch:    fsd.Launch2,
		get:       xfer.Get,
		putFrom:   xfer.PutFrom,
		container: containerFs2,
	}
}

var (
	fs2FlagsRe = regexp.MustCompile(`^o?p?r?$`) // sorted-unique subset of "o", "r", "p": canonical order is o, p, r
	fs2ShaRe   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	fs2EtagRe  = regexp.MustCompile(`^\d{1,20}-\d{1,20}$`)
	fs2ModeRe  = regexp.MustCompile(`^[0-7]{3,4}$`)
)

func (g *fs2Gate) reply(res protocol.Fs2Result) {
	res.Type = "fs2_result"
	_ = g.send(res)
}

func (g *fs2Gate) fail(reqID, code, msg string) {
	g.reply(protocol.Fs2Result{ReqID: reqID, OK: false, Code: code, Error: msg})
}

func fs2Timeout(ms int) time.Duration {
	if ms <= 0 {
		return fs2DefaultTimeout
	}
	d := time.Duration(ms) * time.Millisecond
	if d < fs2MinTimeout {
		return fs2MinTimeout
	}
	if d > fs2MaxTimeout {
		return fs2MaxTimeout
	}
	return d
}

// validateFields cheaply rejects a malformed (but correctly signed) request before any resource is taken.
func validateFs2Fields(m protocol.ServerMsg) string {
	if m.Size < 0 {
		return "invalid size"
	}
	if !fs2FlagsRe.MatchString(m.Flags) {
		return "invalid flags"
	}
	if m.Mode != "" {
		v, err := strconv.ParseUint(m.Mode, 8, 32)
		if !fs2ModeRe.MatchString(m.Mode) || err != nil || v > 0o777 {
			return "invalid mode" // octal, and never setuid/setgid/sticky
		}
	}
	if m.Sha256 != "" && !fs2ShaRe.MatchString(m.Sha256) {
		return "invalid sha256"
	}
	if m.IfMatch != "" && !fs2EtagRe.MatchString(m.IfMatch) {
		return "invalid ifMatch"
	}
	switch m.Op {
	case "write":
		if m.Scope == "volume" && m.Sha256 == "" {
			return "sha256 is required"
		}
		if !xfer.ValidPath(m.Xfer) {
			return "invalid transfer path"
		}
	case "read":
		if !xfer.ValidPath(m.Xfer) {
			return "invalid transfer path"
		}
	default:
		if m.Xfer != "" {
			return "unexpected transfer path"
		}
	}
	return ""
}

// handle is the fail-closed gate for one fs2_req. The reader goroutine calls it inline; it returns quickly and
// runs the op on its own goroutine. Exactly one fs2_result is sent for every request that passes the signature,
// expiry and capability checks.
func (g *fs2Gate) handle(ctx context.Context, m protocol.ServerMsg) {
	// 1. Signature over EVERY field (length-prefixed canonical form). Unsigned/forged: drop silently, like fs_req.
	f := protocol.Fs2Fields{
		ReqID: m.ReqID, Op: m.Op, Scope: m.Scope, Subject: m.Subject, Path: m.Path, Path2: m.Path2, Mode: m.Mode,
		Flags: m.Flags, Size: m.Size, Sha256: m.Sha256, IfMatch: m.IfMatch, Xfer: m.Xfer, TimeoutMs: m.TimeoutMs,
		Exp: m.Exp, Capability: m.Capability,
	}
	if !protocol.VerifySig(g.hubPub, protocol.CanonicalFs2(f), m.Sig) {
		fmt.Fprintln(os.Stderr, "rejected fs2_req: invalid or missing hub signature")
		return
	}
	// 2. Expiry.
	nowT := g.now()
	if nowT.Unix() > m.Exp {
		g.fail(m.ReqID, fsd.CodeExpired, "request expired")
		return
	}
	// 3. Replay cache.
	if !g.state.remember(m.ReqID, m.Exp, nowT.Unix()) {
		g.fail(m.ReqID, fsd.CodeBusy, "duplicate or over-capacity request")
		return
	}
	// 4. Capability SET, re-derived locally; the signed capability must be its last element.
	req := protocol.Fs2RequiredCaps(m.Scope, m.Op)
	if len(req) == 0 {
		g.fail(m.ReqID, fsd.CodeBadRequest, "unsupported operation")
		return
	}
	for _, c := range req {
		if !g.cs.allows(c) {
			fmt.Fprintf(os.Stderr, "rejected fs2_req: capability not allowed: %s (%s %s)\n", c, m.Scope, m.Op)
			return
		}
	}
	if m.Capability != req[len(req)-1] {
		fmt.Fprintln(os.Stderr, "rejected fs2_req: signed capability does not match the operation")
		return
	}
	if msg := validateFs2Fields(m); msg != "" {
		g.fail(m.ReqID, fsd.CodeBadRequest, msg)
		return
	}
	// 5. Volume ops need the locally configured agent image; container ops do not.
	if m.Scope == "volume" && g.cfg.AgentImage == "" {
		g.fail(m.ReqID, fsd.CodeNotConf, "file operations are not configured on this agent")
		return
	}
	timeout := fs2Timeout(m.TimeoutMs)
	// The deadline starts NOW so waiting for a slot / the volume lock counts against the op's budget.
	opCtx, cancel := context.WithTimeout(ctx, timeout)
	go func() {
		defer cancel()
		g.run(opCtx, m)
	}()
}

func (g *fs2Gate) run(ctx context.Context, m protocol.ServerMsg) {
	// 6. Global concurrency cap (short wait, then busy).
	wait := time.NewTimer(g.semWait)
	defer wait.Stop()
	select {
	case g.state.sem <- struct{}{}:
		defer func() { <-g.state.sem }()
	case <-wait.C:
		g.fail(m.ReqID, fsd.CodeBusy, "too many file operations in flight")
		return
	case <-ctx.Done():
		g.fail(m.ReqID, fsd.CodeFailed, "file operation timed out")
		return
	}
	// Mutating volume ops are serialized per volume (blocking, bounded by the op deadline).
	if m.Scope == "volume" && protocol.Fs2MutatingOp(m.Op) {
		l := g.state.volLock(m.Subject)
		select {
		case l <- struct{}{}:
			defer func() { <-l }()
		case <-ctx.Done():
			g.fail(m.ReqID, fsd.CodeBusy, "volume is busy with another write")
			return
		}
	}
	if m.Scope == "container" {
		if g.container == nil {
			g.fail(m.ReqID, fsd.CodeUnsupp, "container filesystem is not available in this agent build")
			return
		}
		res := g.container(ctx, m, g)
		res.ReqID = m.ReqID
		g.reply(res)
		return
	}
	g.reply(g.runVolume(ctx, m))
}

func (g *fs2Gate) runVolume(ctx context.Context, m protocol.ServerMsg) protocol.Fs2Result {
	r := fsd.Req2{Op: m.Op, Path: m.Path, Path2: m.Path2, Mode: m.Mode, Flags: m.Flags, Sha256: m.Sha256, IfMatch: m.IfMatch, Size: m.Size}
	res := protocol.Fs2Result{ReqID: m.ReqID}
	switch m.Op {
	case "write":
		origin, err := xfer.Origin(g.cfg.HubURL)
		if err != nil {
			return fs2Err(m.ReqID, err)
		}
		body, err := g.get(ctx, origin, m.Xfer, m.Size)
		if err != nil {
			fmt.Fprintf(os.Stderr, "fs2: fetch upload body failed: %v\n", err)
			return fs2Err(m.ReqID, &fsd.Error{Code: fsd.CodeFailed, Msg: "could not fetch the upload from the hub"})
		}
		defer body.Close()
		out, err := g.launch(ctx, g.cfg.AgentImage, m.Subject, r, body, nil)
		if err != nil {
			return fs2Err(m.ReqID, err)
		}
		res.OK, res.Bytes, res.Sha256, res.Etag, res.Created = true, out.Bytes, out.Sha256, out.Etag, out.Created
	case "read":
		origin, err := xfer.Origin(g.cfg.HubURL)
		if err != nil {
			return fs2Err(m.ReqID, err)
		}
		h := sha256.New()
		var sent int64
		err = g.putFrom(ctx, origin, m.Xfer, m.Size, func(pctx context.Context, w io.Writer) error {
			cw := &countHashWriter{w: w, h: h, n: &sent}
			_, lerr := g.launch(pctx, g.cfg.AgentImage, m.Subject, r, nil, cw)
			return lerr
		})
		if err != nil {
			return fs2Err(m.ReqID, err)
		}
		res.OK, res.Bytes, res.Sha256 = true, sent, hex.EncodeToString(h.Sum(nil))
	default:
		out, err := g.launch(ctx, g.cfg.AgentImage, m.Subject, r, nil, nil)
		if err != nil {
			return fs2Err(m.ReqID, err)
		}
		res.OK, res.Stat, res.Created = true, out.Stat, out.Created
		if m.Op == "mkdir" && out.Stat != nil {
			res.Created = true
		}
	}
	return res
}

type countHashWriter struct {
	w io.Writer
	h io.Writer
	n *int64
}

func (c *countHashWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	if n > 0 {
		_, _ = c.h.Write(p[:n])
		*c.n += int64(n)
	}
	return n, err
}

// fs2Err converts a launcher/driver error into a failed result. Typed helper errors keep their code; a timeout and
// anything else collapse to `failed` with a fixed message (host-side detail never goes on the wire).
func fs2Err(reqID string, err error) protocol.Fs2Result {
	res := protocol.Fs2Result{ReqID: reqID, OK: false, Code: fsd.CodeFailed, Error: "file operation failed"}
	var te *fsd.Error
	switch {
	case errors.As(err, &te):
		res.Code, res.Error = te.Code, te.Msg
	case fsd.IsTimeout(err), errors.Is(err, context.DeadlineExceeded):
		res.Error = "file operation timed out"
	case errors.Is(err, fs.ErrNotExist):
		res.Code, res.Error = fsd.CodeNotFound, "not found"
	}
	if len(res.Error) > 200 {
		res.Error = res.Error[:200]
	}
	res.Error = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, res.Error)
	return res
}
