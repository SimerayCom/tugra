package coolify

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/coolify/laravel"
	"github.com/SimerayCom/tugra/agent/internal/coolify/open"
	"github.com/SimerayCom/tugra/agent/internal/coolify/seal"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// Refusal codes sent back for a frame that never ran (a closed set; the hub maps each to a fixed message).
const (
	RefusedExpired       = "expired"
	RefusedReplay        = "replay"
	RefusedDenied        = "denied"
	RefusedBadRequest    = "bad_request"
	RefusedBusy          = "busy"
	RefusedRateLimited   = "rate_limited"
	RefusedNotConfigured = "not_configured"
	RefusedFailed        = "failed"
	RefusedRevoked       = "revoked"
)

const (
	capability       = protocol.CapCoolifySecrets
	maxRefs          = 200
	maxExpAheadSec   = 15 * 60
	clockSkewSec     = 60
	maxRunDuration   = 10 * time.Minute
	rateLimit        = 6 // requests per minute
	maxStageBytes    = 64 << 20
	maxResultRecords = 100
	maxResultBytes   = 512 << 10
	maxHelperLine    = 4 << 20
	replayMax        = 1024
)

// RunFunc runs one command. The production one uses os/exec; tests inject a fake docker. stdout receives the process output; stderr a
// bounded copy of its error text.
type RunFunc func(ctx context.Context, argv []string, stdin io.Reader, stdout, stderr io.Writer) error

// State is the process-level state of the gate: the replay cache, the single-flight flag and the rate window. It outlives one hub
// connection, so a frame captured before a reconnect cannot be replayed on the next socket.
type State struct {
	mu       sync.Mutex
	seen     map[string]int64
	inFlight bool
	window   []time.Time
}

// NewState makes an empty State.
func NewState() *State { return &State{seen: map[string]int64{}} }

func (s *State) remember(reqID string, exp, now int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.seen) >= replayMax {
		for id, e := range s.seen {
			if e+clockSkewSec < now {
				delete(s.seen, id)
			}
		}
	}
	if _, dup := s.seen[reqID]; dup || len(s.seen) >= replayMax {
		return false
	}
	s.seen[reqID] = exp
	return true
}

// acquire takes the single flight slot and counts one request in the minute window.
func (s *State) acquire(now time.Time) (ok bool, code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := s.window[:0]
	for _, t := range s.window {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	s.window = keep
	if len(s.window) >= rateLimit {
		return false, RefusedRateLimited
	}
	if s.inFlight {
		return false, RefusedBusy
	}
	s.inFlight = true
	s.window = append(s.window, now)
	return true, ""
}

func (s *State) release() {
	s.mu.Lock()
	s.inFlight = false
	s.mu.Unlock()
}

// Config wires a Gate. Everything attacker-reachable is checked in Handle before any process is started.
type Config struct {
	ServerID   string // the agent's OWN stored id (never read from a frame)
	AgentImage string // TUGRA_AGENT_IMAGE (never read from a frame)
	HubPub     ed25519.PublicKey
	Allows     func(capability string) bool
	Send       func(any) error
	Now        func() time.Time
	Run        RunFunc
	Rand       io.Reader
	Logf       func(format string, args ...any)
	State      *State
}

// Gate verifies and runs coolify_secrets_req frames for one connection.
type Gate struct {
	c  Config
	wg sync.WaitGroup
}

// NewGate fills the defaults (real clock, os/exec, crypto/rand, a fresh State).
func NewGate(c Config) *Gate {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Run == nil {
		c.Run = ExecRun
	}
	if c.Rand == nil {
		c.Rand = rand.Reader
	}
	if c.Logf == nil {
		c.Logf = func(string, ...any) {}
	}
	if c.State == nil {
		c.State = NewState()
	}
	return &Gate{c: c}
}

// Wait blocks until every running request has finished (tests).
func (g *Gate) Wait() { g.wg.Wait() }

func (g *Gate) reply(m protocol.CoolifySecretsResult) {
	m.Type = "coolify_secrets_result"
	_ = g.c.Send(m)
}

func (g *Gate) refuse(reqID, code string) {
	g.reply(protocol.CoolifySecretsResult{ReqID: reqID, OK: false, Code: code, Final: true})
}

// Handle is the fail-closed gate. Order: signature, expiry, replay, capability, field validation, recipient key, image, rate limit and
// single flight, and only then a goroutine. Nothing is run, and no docker command is built, before every check has passed.
func (g *Gate) Handle(ctx context.Context, m protocol.ServerMsg) {
	f := protocol.CoolifySecretsFields{
		ServerID: g.c.ServerID, ReqID: m.ReqID, RunID: m.RunID, Classes: m.Classes, Refs: m.Refs,
		RecipientKey: m.RecipientKey, Exp: m.Exp, Capability: m.Capability,
	}
	// 1. Signature over every field, with this agent's own server id. Unsigned or forged frames are dropped silently, like fs2_req.
	if !protocol.VerifySig(g.c.HubPub, protocol.CanonicalCoolifySecrets(f), m.Sig) {
		g.c.Logf("rejected coolify_secrets_req: invalid or missing hub signature")
		return
	}
	now := g.c.Now()
	// 2. Expiry, with a skew allowance, and a ceiling on how far ahead a frame may be valid.
	if now.Unix() > m.Exp+clockSkewSec {
		g.refuse(m.ReqID, RefusedExpired)
		return
	}
	if m.Exp > now.Unix()+maxExpAheadSec+clockSkewSec {
		g.refuse(m.ReqID, RefusedBadRequest)
		return
	}
	// 3. Replay cache.
	if !g.c.State.remember(m.ReqID, m.Exp, now.Unix()) {
		g.refuse(m.ReqID, RefusedReplay)
		return
	}
	// 4. Capability, derived locally; the signed capability must be exactly this one.
	if m.Capability != capability || g.c.Allows == nil || !g.c.Allows(capability) {
		g.c.Logf("rejected coolify_secrets_req: capability not allowed")
		g.refuse(m.ReqID, RefusedDenied)
		return
	}
	// 5. Field validation.
	plan, ok := validate(m)
	if !ok {
		g.refuse(m.ReqID, RefusedBadRequest)
		return
	}
	recipient, err := seal.ParseRecipient(m.RecipientKey)
	if err != nil {
		g.refuse(m.ReqID, RefusedBadRequest)
		return
	}
	if g.c.AgentImage == "" || !imageRe.MatchString(g.c.AgentImage) {
		g.refuse(m.ReqID, RefusedNotConfigured)
		return
	}
	// 6. Single flight and the rate window.
	if ok, code := g.c.State.acquire(now); !ok {
		g.refuse(m.ReqID, code)
		return
	}
	runCtx, cancel := context.WithTimeout(ctx, runBudget(now, m.Exp))
	g.wg.Add(1)
	go func() {
		defer g.wg.Done()
		defer cancel()
		defer g.c.State.release()
		g.serve(runCtx, m.ReqID, m.RunID, recipient, plan)
	}()
}

func runBudget(now time.Time, exp int64) time.Duration {
	d := time.Duration(exp-now.Unix()+clockSkewSec) * time.Second
	if d > maxRunDuration || d <= 0 {
		return maxRunDuration
	}
	return d
}

// plan is a validated request.
type plan struct {
	consent map[string]bool
	// ids per kind, in request order, deduplicated
	byKind map[string][]string
	order  []string // refs in request order
	asked  map[string]bool
}

func validate(m protocol.ServerMsg) (plan, bool) {
	p := plan{consent: map[string]bool{}, byKind: map[string][]string{}, asked: map[string]bool{}}
	if !runIDRe.MatchString(m.RunID) || len(m.Classes) == 0 || len(m.Classes) > len(Classes) || len(m.Refs) == 0 || len(m.Refs) > maxRefs {
		return p, false
	}
	for _, c := range m.Classes {
		if !knownClass(c) || p.consent[c] {
			return p, false
		}
		p.consent[c] = true
	}
	for _, ref := range m.Refs {
		kind, id, ok := SplitRef(ref)
		if !ok || p.asked[ref] {
			return p, false
		}
		if !kindHasClass(kind, p.consent) {
			return p, false // the ref names a kind none of whose fields the owner consented to
		}
		p.asked[ref] = true
		p.order = append(p.order, ref)
		p.byKind[kind] = append(p.byKind[kind], id)
	}
	return p, true
}

// ---- the run -------------------------------------------------------------------------------------------------------------------

type outBatch struct {
	g       *Gate
	reqID   string
	recs    []protocol.CoolifySecretRecord
	bytes   int
	revoked func() bool
}

func (b *outBatch) add(r protocol.CoolifySecretRecord) bool {
	b.recs = append(b.recs, r)
	b.bytes += len(r.Env) + len(r.Ref) + len(r.Field) + 32
	if len(b.recs) >= maxResultRecords || b.bytes >= maxResultBytes {
		return b.flush(false)
	}
	return true
}

func (b *outBatch) flush(final bool) bool {
	if len(b.recs) == 0 && !final {
		return true
	}
	if b.revoked != nil && b.revoked() {
		return false
	}
	b.g.reply(protocol.CoolifySecretsResult{ReqID: b.reqID, OK: true, Records: b.recs, Final: final})
	b.recs, b.bytes = nil, 0
	return true
}

func (g *Gate) serve(ctx context.Context, reqID, runID string, recipient []byte, p plan) {
	sc := &scrubber{}
	revoked := func() bool { return g.c.Allows == nil || !g.c.Allows(capability) }
	batch := &outBatch{g: g, reqID: reqID, revoked: revoked}
	finish := func(code string) {
		if code == "" {
			if !batch.flush(true) {
				g.reply(protocol.CoolifySecretsResult{ReqID: reqID, OK: false, Code: RefusedRevoked, Final: true})
			}
			return
		}
		g.reply(protocol.CoolifySecretsResult{ReqID: reqID, OK: false, Code: code, Final: true})
	}

	rows, direct, code := g.stageA(ctx, p, revoked)
	if code != "" {
		finish(code)
		return
	}
	for _, r := range direct {
		if !batch.add(r) {
			finish(RefusedRevoked)
			return
		}
	}
	if len(rows) == 0 {
		finish("")
		return
	}
	// Stage B only runs when there is something to decrypt.
	if revoked() {
		finish(RefusedRevoked)
		return
	}
	key, prev, code := g.stageB(ctx, sc)
	if code != "" {
		finish(code)
		return
	}
	if key == "" {
		for _, r := range rows {
			if !batch.add(protocol.CoolifySecretRecord{Ref: r.Ref, Field: r.Field, Code: laravel.CodeNoKey}) {
				finish(RefusedRevoked)
				return
			}
		}
		finish("")
		return
	}
	code = g.stageC(ctx, sc, runID, recipient, key, prev, rows, p, batch, revoked)
	finish(code)
}

// psqlRow is one stdout line of stage A.
type psqlRow struct {
	Ref string `json:"ref"`
	F   map[string]struct {
		P bool    `json:"p"`
		V *string `json:"v"`
	} `json:"f"`
}

// stageA reads the stored (still encrypted) values of the requested refs. It returns the rows to decrypt and the records the agent can
// answer by itself (a missing column, an oversized value, a ref that exists nowhere). code is non-empty only for a failure of the run.
func (g *Gate) stageA(ctx context.Context, p plan, revoked func() bool) (rows []open.Row, direct []protocol.CoolifySecretRecord, code string) {
	found := map[string]bool{}
	var total int
	for _, kind := range Kinds {
		ids := p.byKind[kind]
		if len(ids) == 0 {
			continue
		}
		for _, t := range kindTables[kind] {
			if revoked() {
				return nil, nil, RefusedRevoked
			}
			sql, fields, err := BuildQuery(t, ids, p.consent)
			if err != nil || sql == "" {
				continue
			}
			var out bytes.Buffer
			var errb limitedBuffer
			if err := g.c.Run(ctx, PsqlArgv(), strings.NewReader(sql), &capWriter{w: &out, max: maxStageBytes}, &errb); err != nil {
				if ctx.Err() != nil {
					return nil, nil, RefusedFailed
				}
				// A table this Coolify version lacks (or a guard column it lacks): that table yields nothing.
				g.c.Logf("coolify secrets: a source table could not be read (%s)", kind)
				continue
			}
			sc := bufio.NewScanner(&out)
			sc.Buffer(make([]byte, 64<<10), maxStageBytes)
			for sc.Scan() {
				line := bytes.TrimSpace(sc.Bytes())
				if len(line) == 0 {
					continue
				}
				var r psqlRow
				if json.Unmarshal(line, &r) != nil || !p.asked[kind+":"+r.Ref] {
					continue
				}
				ref := kind + ":" + r.Ref
				found[ref] = true
				for _, f := range fields {
					cell, present := r.F[f.Col]
					switch {
					case !present || !cell.P:
						if f.Optional {
							continue // this Coolify version does not have the column: nothing to read, nothing to report
						}
						direct = append(direct, protocol.CoolifySecretRecord{Ref: ref, Field: f.Col, Code: "column_missing"})
					case cell.V == nil:
						// NULL is a valid value (preserve_compose_null): no record, the hub keeps NULL.
					case len(*cell.V) > laravel.MaxPayloadBytes:
						direct = append(direct, protocol.CoolifySecretRecord{Ref: ref, Field: f.Col, Code: laravel.CodeTooLarge})
					default:
						total += len(*cell.V)
						if total > maxStageBytes || len(rows) >= open.MaxRows {
							return nil, nil, RefusedFailed
						}
						rows = append(rows, open.Row{Ref: ref, Field: f.Col, Class: f.Class, Form: f.Form, PlainOK: f.PlainOK, V: *cell.V})
					}
				}
			}
		}
	}
	for _, ref := range p.order {
		if !found[ref] {
			direct = append(direct, protocol.CoolifySecretRecord{Ref: ref, Field: "*", Code: "column_missing"})
		}
	}
	return rows, direct, ""
}

// stageB reads the app key (and previous keys) from the Coolify container. The bytes stay in this process and go to the helper's stdin.
func (g *Gate) stageB(ctx context.Context, sc *scrubber) (key, prev string, code string) {
	var out bytes.Buffer
	var errb limitedBuffer
	if err := g.c.Run(ctx, KeyArgv(), nil, &capWriter{w: &out, max: 64 << 10}, &errb); err != nil {
		g.c.Logf("coolify secrets: the app key could not be read")
		return "", "", RefusedFailed
	}
	defer func() {
		b := out.Bytes()
		for i := range b {
			b[i] = 0
		}
	}()
	lines := strings.SplitN(out.String(), "\n", 3)
	key = strings.TrimSpace(lines[0])
	if len(lines) > 1 {
		prev = strings.TrimSpace(lines[1])
	}
	sc.add(key)
	for _, p := range strings.Split(prev, ",") {
		sc.add(p)
	}
	return key, prev, ""
}

var fieldRe = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)

var okWireCodes = map[string]bool{
	"bad_mac": true, "bad_payload": true, "no_key": true, "key_prev": true, "unsupported_cipher": true,
	"unsupported_serialization": true, "column_missing": true, "too_large": true,
}

// stageC runs the helper: key line and rows in, sealed records out, relayed as they come. The agent never parses an envelope body; it
// only checks that what it relays is a tse1 envelope or a fixed code for a ref that was asked for.
func (g *Gate) stageC(ctx context.Context, sc *scrubber, runID string, recipient []byte, key, prev string, rows []open.Row, p plan, batch *outBatch, revoked func() bool) string {
	var nameRaw [8]byte
	if _, err := io.ReadFull(g.c.Rand, nameRaw[:]); err != nil {
		return RefusedFailed
	}
	name := "tugra-coolify-open-" + hex.EncodeToString(nameRaw[:])
	argv, err := HelperArgv(g.c.AgentImage, name, runID, g.c.ServerID, base64.StdEncoding.EncodeToString(recipient))
	if err != nil {
		return RefusedBadRequest
	}
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	var errb limitedBuffer
	runErr := make(chan error, 1)
	runCtx, stopRun := context.WithCancel(ctx)
	defer stopRun()
	go func() {
		err := g.c.Run(runCtx, argv, stdinR, stdoutW, &errb)
		_ = stdoutW.CloseWithError(err)
		_ = stdinR.Close()
		runErr <- err
	}()
	go func() {
		defer stdinW.Close()
		enc := json.NewEncoder(stdinW)
		if enc.Encode(open.KeyLine{Key: key, Prev: prev}) != nil {
			return
		}
		for _, r := range rows {
			if revoked() || ctx.Err() != nil || enc.Encode(r) != nil {
				return
			}
		}
	}()

	dropped := 0
	rd := bufio.NewReaderSize(stdoutR, 64<<10)
	aborted := ""
	for aborted == "" {
		line, err := readBoundedLine(rd, maxHelperLine)
		if err != nil {
			break
		}
		var rec protocol.CoolifySecretRecord
		if json.Unmarshal(line, &rec) != nil || !relayable(rec, p) {
			dropped++
			continue
		}
		if revoked() {
			aborted = RefusedRevoked
			break
		}
		if !batch.add(rec) {
			aborted = RefusedRevoked
		}
	}
	_ = stdoutR.Close()
	if aborted == "" && revoked() {
		aborted = RefusedRevoked // the grant ended while the helper ran: what it produced is not delivered as a complete answer
	}
	if aborted != "" {
		stopRun() // do not wait for a helper whose output nobody reads any more
	}
	werr := <-runErr
	if ctx.Err() != nil || aborted != "" {
		g.removeContainer(name)
	}
	if dropped > 0 {
		g.c.Logf("coolify secrets: %d malformed helper lines dropped", dropped)
	}
	if aborted != "" {
		return aborted
	}
	if werr != nil {
		g.c.Logf("coolify secrets: helper failed: %s", sc.clean(errb.String(), 200))
		return RefusedFailed
	}
	if s := errb.String(); s != "" {
		g.c.Logf("coolify secrets: helper said: %s", sc.clean(s, 200))
	}
	return ""
}

// relayable is the agent-side filter on a helper line: a sealed envelope, or one fixed code, for a ref that was asked for.
func relayable(r protocol.CoolifySecretRecord, p plan) bool {
	if !p.asked[r.Ref] || (!fieldRe.MatchString(r.Field) && r.Field != "*") {
		return false
	}
	if r.Env != "" {
		return r.Code == "" && knownClass(r.Class) && p.consent[r.Class] && strings.HasPrefix(r.Env, seal.Prefix) && len(r.Env) <= 2<<20
	}
	return r.Class == "" && okWireCodes[r.Code]
}

func (g *Gate) removeContainer(name string) {
	argv, err := RemoveArgv(name)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = g.c.Run(ctx, argv, nil, io.Discard, io.Discard)
}

// ---- small helpers -------------------------------------------------------------------------------------------------------------

func readBoundedLine(rd *bufio.Reader, max int) ([]byte, error) {
	var out []byte
	for {
		chunk, isPrefix, err := rd.ReadLine()
		if err != nil {
			return nil, err
		}
		out = append(out, chunk...)
		if len(out) > max {
			return nil, errors.New("line too long")
		}
		if !isPrefix {
			return out, nil
		}
	}
}

// limitedBuffer keeps the first 4 KiB written to it.
type limitedBuffer struct{ b []byte }

func (l *limitedBuffer) Write(p []byte) (int, error) {
	if room := 4096 - len(l.b); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		l.b = append(l.b, p[:room]...)
	}
	return len(p), nil
}
func (l *limitedBuffer) String() string { return string(l.b) }

// capWriter fails a write that would grow the buffer past max.
type capWriter struct {
	w   io.Writer
	n   int
	max int
}

func (c *capWriter) Write(p []byte) (int, error) {
	if c.n+len(p) > c.max {
		return 0, errors.New("output too large")
	}
	c.n += len(p)
	return c.w.Write(p)
}

// ExecRun is the production RunFunc: os/exec with a process group of its own is not needed for docker's client, the context kills it.
func ExecRun(ctx context.Context, argv []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(argv) == 0 || argv[0] != "docker" {
		return errors.New("only docker commands are run here")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	return cmd.Run()
}
