// Package client runs the agent's outbound WebSocket session to the hub.
package client

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/dockerstats"
	"github.com/SimerayCom/tugra/agent/internal/drains"
	"github.com/SimerayCom/tugra/agent/internal/exec"
	"github.com/SimerayCom/tugra/agent/internal/fsd"
	"github.com/SimerayCom/tugra/agent/internal/hostinfo"
	"github.com/SimerayCom/tugra/agent/internal/journal"
	"github.com/SimerayCom/tugra/agent/internal/keys"
	"github.com/SimerayCom/tugra/agent/internal/logs"
	"github.com/SimerayCom/tugra/agent/internal/metrics"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
	"github.com/SimerayCom/tugra/agent/internal/selfupdate"
	"github.com/SimerayCom/tugra/agent/internal/terminal"
	"github.com/SimerayCom/tugra/agent/internal/traffic"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

const (
	metricsInterval        = 5 * time.Second
	containerStatsInterval = 15 * time.Second // per-container `docker stats` — slower than host metrics
	commandTimeout         = 20 * time.Second
	trafficInterval        = 60 * time.Second // proxy access-log -> per-domain traffic summary window
	hostInfoInterval       = 12 * time.Hour   // refresh hardware/OS inventory periodically
	fsOpTimeout            = 30 * time.Second // hard wall-clock bound on one sandboxed file op

	// maxMessageBytes bounds one inbound hub frame. coder/websocket defaults to 32768, which a large
	// signed command (big compose file / env blob / base64 script) exceeds, dropping the connection.
	maxMessageBytes = 16 << 20
)

// errStaleIdentity signals that the hub explicitly asked us to re-enroll (Code "reenroll"). Run
// retries once via a FORCED enroll WITHOUT clearing the persisted identity — the stored serverId/seal
// are overwritten only when that enroll succeeds, so a spurious/transient signal cannot destroy a
// good identity.
var errStaleIdentity = errors.New("hub requested re-enroll")

// reenrollCode is the hub's explicit "your identity is gone, enroll fresh" signal (ServerMsg.Code).
// It is the ONLY rejection that triggers a re-enroll retry — see shouldForgetIdentity.
const reenrollCode = "reenroll"

// shouldForgetIdentity decides whether a non-OK handshake reply warrants a re-enroll retry. It returns
// true ONLY when we authenticated with a stored identity, a fresh enroll could actually work (a token
// is set), AND the hub explicitly told us to re-enroll (Code == "reenroll"). It does NOT itself discard
// anything: the caller retries via a forced enroll and overwrites the persisted identity only once that
// enroll succeeds. A generic or transient rejection — a hub restart mid-handshake, a DB hiccup, or a
// signature mismatch against a still-enrolled server — returns false, so the identity is left untouched
// and the agent simply retries auth. Clearing a good identity on such a signal would brick the agent
// for good, because enroll cannot succeed against a server that is already enrolled.
func shouldForgetIdentity(usedAuth bool, token string, resp protocol.ServerMsg) bool {
	return usedAuth && token != "" && resp.Code == reenrollCode
}

// Run dials the hub, authenticates (enroll or reconnect), then streams metrics
// + heartbeats and executes commands until the context is cancelled. onReady (may be nil) is
// invoked once the handshake succeeds (enrolled/auth_ok) so the caller can reset its backoff.
//
// If the hub explicitly asks us to re-enroll (Code "reenroll") and a token is configured, the session
// is retried once immediately via the enroll path — WITHOUT first clearing the stored identity, which
// is overwritten only when the fresh enroll succeeds. So a failed re-enroll leaves the old identity on
// disk for the next auth attempt, and a transient/spurious rejection can never brick a good identity.
func Run(ctx context.Context, cfg config.Config, kp *keys.KeyPair, store *config.Store, onReady func()) error {
	err := runOnce(ctx, cfg, kp, store, onReady, false)
	if errors.Is(err, errStaleIdentity) {
		return runOnce(ctx, cfg, kp, store, onReady, true)
	}
	return err
}

// runOnce runs one hub session. forceEnroll takes the enroll path even when a stored identity exists
// (used for the one-shot re-enroll retry) without touching the persisted identity until enroll succeeds.
func runOnce(ctx context.Context, cfg config.Config, kp *keys.KeyPair, store *config.Store, onReady func(), forceEnroll bool) error {
	conn, _, err := websocket.Dial(ctx, cfg.HubURL, nil)
	if err != nil {
		return err
	}
	conn.SetReadLimit(maxMessageBytes)
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	// Writes from the metrics loop and command handlers must be serialized.
	var writeMu sync.Mutex
	send := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return wsjson.Write(ctx, conn, v)
	}

	var challenge protocol.ServerMsg
	if err := wsjson.Read(ctx, conn, &challenge); err != nil {
		return err
	}
	if challenge.Type != "challenge" {
		return fmt.Errorf("expected challenge, got %q", challenge.Type)
	}

	// The durable command journal is process-level (shared across reconnects) when main.go provides it; a nil
	// one (tests) degrades to a per-connection memory-only registry with the same semantics.
	reg := cfg.Journal
	if reg == nil {
		reg = journal.New("")
	}

	usedAuth := store.ServerID != "" && !forceEnroll
	if usedAuth {
		if err := send(protocol.Auth{
			Type:         "auth",
			Protocol:     protocol.Version,
			ServerID:     store.ServerID,
			Signature:    kp.SignBase64(challenge.Nonce),
			AgentVersion: cfg.Version, // refresh the hub's stored version on reconnect (e.g. after self-update)
			Features:     protocol.Features,
		}); err != nil {
			return err
		}
	} else {
		pub, err := kp.PublicKeySPKIBase64()
		if err != nil {
			return err
		}
		host, _ := os.Hostname()
		if err := send(protocol.Enroll{
			Type:         "enroll",
			Protocol:     protocol.Version,
			Token:        cfg.Token,
			PublicKey:    pub,
			AgentVersion: cfg.Version,
			Hostname:     host,
			Fingerprint:  host,
			Features:     protocol.Features,
		}); err != nil {
			return err
		}
	}

	var resp protocol.ServerMsg
	if err := wsjson.Read(ctx, conn, &resp); err != nil {
		return err
	}
	switch resp.Type {
	case "enrolled":
		store.ServerID = resp.ServerID
		store.Seal = resp.Seal
		_ = store.Save()
	case "auth_ok":
		// already known
	default:
		// Re-enroll only on the hub's explicit "reenroll" signal, and even then WITHOUT clearing the
		// persisted identity here: Run() retries via a forced enroll and the "enrolled" branch above
		// overwrites serverId/seal only on success. A generic/transient rejection keeps the identity and
		// the agent simply retries auth — never a silent self-brick (see shouldForgetIdentity).
		if shouldForgetIdentity(usedAuth, cfg.Token, resp) {
			return errStaleIdentity
		}
		if usedAuth {
			return fmt.Errorf("authentication rejected: %s (identity kept; will retry)", resp.Message)
		}
		return fmt.Errorf("enrollment rejected: %s", resp.Message)
	}
	if onReady != nil {
		onReady()
	}
	// From here this connection is the one journaled commands report on: a command started on an earlier
	// connection emits its command_log/command_result through the registry's sink, which now points at us.
	// Detached on exit so a dead socket is never written to (the journal keeps the result for command_status).
	reg.SetSink(send)
	defer reg.ClearSink()

	// Pin the hub's signing key (TOFU, per connection). Commands/term_start must
	// carry a valid signature from this key or the agent rejects them.
	var hubPub ed25519.PublicKey
	if resp.HubKey != "" {
		if k, err := protocol.ParseHubKey(resp.HubKey); err == nil {
			hubPub = k
		}
	}

	// Fail-closed capability allowlist, seeded from the flags and then made authoritative by the
	// hub's granted set carried in enrolled/auth_ok (nil = an older hub that didn't send it → keep
	// the bootstrap value; an explicit empty [] = deny all). Live-updated via "capabilities" below.
	cs := newCapState(cfg.Capabilities, cfg.CapsBypass)
	if resp.Capabilities != nil {
		cs.set(resp.Capabilities)
	}

	// Send host inventory right after auth, and refresh it periodically so it
	// stays current across server upgrades / kernel patches on long sessions.
	sendHostInfo := func() {
		if info, err := hostinfo.Collect(); err == nil {
			_ = send(protocol.HostInfoMsg{Type: "host_info", Info: info})
		}
	}
	sendHostInfo()
	hostTicker := time.NewTicker(hostInfoInterval)
	defer hostTicker.Stop()

	// Log-drain forwarder: starts/stops on hub "log_drains" config messages.
	fwd := drains.New(store.ServerID)
	defer fwd.Stop()

	// Reader: handle commands + terminal + log-follow sessions from the hub.
	sessions := map[string]*terminal.Session{}
	logStreams := map[string]*logs.Session{}
	// Running commands (by reqId → cancel func) live in the process-level registry, so a signed `command_cancel`
	// can kill one mid-flight — also on a LATER connection than the one it started on (cancelling its context
	// fires exec's Setpgid SIGKILL on the whole process group).
	var sessMu sync.Mutex
	var updating atomic.Bool // single-flight: ignore duplicate agent_update messages once one is in flight
	// Closed when the reader exits (socket gone), so the session returns and reconnects immediately instead of
	// waiting for the next 5s heartbeat write to fail — a hub restart is noticed within milliseconds.
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		// On disconnect, tear down every live terminal + log stream (no zombie shells / `docker logs -f`).
		defer func() {
			sessMu.Lock()
			for _, s := range sessions {
				s.Close()
			}
			for _, s := range logStreams {
				s.Close()
			}
			sessMu.Unlock()
		}()
		for {
			var m protocol.ServerMsg
			if err := wsjson.Read(ctx, conn, &m); err != nil {
				return
			}
			switch m.Type {
			case "command":
				if !protocol.VerifySig(hubPub, protocol.CanonicalCommand(m.ReqID, m.Command, m.TimeoutMs, m.Capability), m.Sig) {
					fmt.Fprintln(os.Stderr, "rejected command: invalid or missing hub signature")
					continue
				}
				if !cs.allows(m.Capability) {
					fmt.Fprintln(os.Stderr, "rejected command: capability not allowed:", m.Capability)
					continue
				}
				// Durable (journaled) command: never run the same reqId twice. A still-running duplicate is
				// ignored (its result will arrive), a finished one gets its stored result re-sent, and one that
				// was running when this agent PROCESS last died is reported with the interruption marker.
				if m.Durable {
					switch disp, e := reg.Begin(m.ReqID, m.Command); disp {
					case journal.Running:
						continue
					case journal.Done:
						_ = reg.Send(protocol.CommandResult{Type: "command_result", ReqID: m.ReqID, ExitCode: e.ExitCode, Output: e.Output})
						continue
					case journal.Interrupted:
						_ = reg.Send(protocol.CommandResult{Type: "command_result", ReqID: m.ReqID, ExitCode: -1, Output: e.Output + "\n" + interruptedMarker})
						continue
					}
				}
				go func(reqID, command string, timeoutMs int, durable bool) {
					to := commandTimeout
					if timeoutMs > 0 {
						to = time.Duration(timeoutMs) * time.Millisecond
					}
					// Per-command cancellable context so a `command_cancel` can SIGKILL its process group. The
					// parent is the PROCESS context (not this connection's): a socket drop must not kill a deploy
					// that is half-way through swapping containers — it finishes and reports on the next connection.
					cmdCtx, cancel := context.WithCancel(ctx)
					var userCancelled atomic.Bool // set ONLY by a signed command_cancel (reg.Cancel), never by shutdown
					reg.Track(reqID, func() {
						userCancelled.Store(true)
						cancel()
					})
					defer func() {
						reg.Untrack(reqID)
						cancel()
					}()
					r := exec.RunStreaming(cmdCtx, command, to, func(chunk string) {
						if durable {
							reg.Chunk(reqID, chunk)
						}
						_ = reg.Send(protocol.CommandLog{
							Type:  "command_log",
							ReqID: reqID,
							Chunk: chunk,
						})
					})
					// Agent shutdown (the PROCESS ctx was cancelled: SIGTERM, restart, self-update): the kill was not a
					// user cancel and the outcome is unknowable — journal NO verdict, so the persisted running entry
					// reloads as "interrupted" on the next start, and send nothing (the hub settles it honestly).
					if ctx.Err() != nil {
						return
					}
					// killed = a signed command_cancel reached us — distinct from the command's own timeout (exec's inner
					// deadline leaves cmdCtx intact) and, per the check above, from shutdown.
					killed := userCancelled.Load()
					if durable {
						reg.Finish(reqID, r.ExitCode, killed)
					}
					_ = reg.Send(protocol.CommandResult{
						Type:     "command_result",
						ReqID:    reqID,
						ExitCode: r.ExitCode,
						Output:   r.Output,
					})
				}(m.ReqID, m.Command, m.TimeoutMs, m.Durable)
			case "command_cancel":
				// Kill a running command's process group. Verified by the hub signature over the reqId; the
				// command was already capability-gated when it started, so cancelling needs no extra grant.
				if !protocol.VerifySig(hubPub, protocol.CanonicalCommandCancel(m.ReqID), m.Sig) {
					fmt.Fprintln(os.Stderr, "rejected command_cancel: invalid or missing hub signature")
					continue
				}
				reg.Cancel(m.ReqID)
			case "command_status":
				// Read-only journal lookup (cmd_journal_v1). Verified by the hub signature over the reqId; nothing is
				// executed in response, so no capability check is needed. Answers on THIS connection.
				if !protocol.VerifySig(hubPub, protocol.CanonicalCommandStatus(m.ReqID), m.Sig) {
					fmt.Fprintln(os.Stderr, "rejected command_status: invalid or missing hub signature")
					continue
				}
				e, disp := reg.Status(m.ReqID)
				st := protocol.CommandState{Type: "command_state", ReqID: m.ReqID, State: disp.String(), StartedAt: e.StartedAt}
				switch disp {
				case journal.Done:
					st.ExitCode, st.Output, st.Killed, st.FinishedAt = e.ExitCode, e.Output, e.Killed, e.FinishedAt
				case journal.Running:
					st.Output = e.Output
				case journal.Interrupted:
					st.Output = e.Output
				}
				_ = send(st)
			case "term_start":
				if !protocol.VerifySig(hubPub, protocol.CanonicalTermStart(m.SessionID, m.Target, m.Cols, m.Rows, m.Capability), m.Sig) {
					fmt.Fprintln(os.Stderr, "rejected term_start: invalid or missing hub signature")
					continue
				}
				if !cs.allows(m.Capability) {
					fmt.Fprintln(os.Stderr, "rejected term_start: capability not allowed:", m.Capability)
					continue
				}
				sid := m.SessionID
				sess, err := terminal.Start(m.Target, m.Cols, m.Rows,
					func(b []byte) {
						_ = send(protocol.TermOutput{
							Type:      "term_output",
							SessionID: sid,
							Data:      base64.StdEncoding.EncodeToString(b),
						})
					},
					func(code int) {
						sessMu.Lock()
						delete(sessions, sid)
						sessMu.Unlock()
						_ = send(protocol.TermExit{Type: "term_exit", SessionID: sid, ExitCode: code})
					},
				)
				if err != nil {
					_ = send(protocol.TermExit{Type: "term_exit", SessionID: sid, ExitCode: -1})
					continue
				}
				sessMu.Lock()
				sessions[sid] = sess
				sessMu.Unlock()
			case "term_input":
				sessMu.Lock()
				sess := sessions[m.SessionID]
				sessMu.Unlock()
				if sess != nil {
					if data, err := base64.StdEncoding.DecodeString(m.Data); err == nil {
						_, _ = sess.Write(data)
					}
				}
			case "term_resize":
				sessMu.Lock()
				sess := sessions[m.SessionID]
				sessMu.Unlock()
				if sess != nil {
					_ = sess.Resize(m.Cols, m.Rows)
				}
			case "term_close":
				sessMu.Lock()
				sess := sessions[m.SessionID]
				sessMu.Unlock()
				if sess != nil {
					sess.Close()
				}
			case "log_start":
				// Same fail-closed order as term_start: verify the hub signature, then the capability.
				if !protocol.VerifySig(hubPub, protocol.CanonicalLogStart(m.StreamID, m.Target, m.Tail, m.Follow, m.Since, m.Search, m.Capability), m.Sig) {
					fmt.Fprintln(os.Stderr, "rejected log_start: invalid or missing hub signature")
					continue
				}
				if !cs.allows(m.Capability) {
					fmt.Fprintln(os.Stderr, "rejected log_start: capability not allowed:", m.Capability)
					continue
				}
				sid := m.StreamID
				stream, err := logs.Start(m.Target, m.Tail, m.Since, m.Follow, m.Search, m.Service,
					func(line string) {
						_ = send(protocol.LogChunk{Type: "log_chunk", StreamID: sid, Chunk: line})
					},
					func(code int) {
						sessMu.Lock()
						delete(logStreams, sid)
						sessMu.Unlock()
						_ = send(protocol.LogExit{Type: "log_exit", StreamID: sid, ExitCode: code})
					},
				)
				if err != nil {
					_ = send(protocol.LogExit{Type: "log_exit", StreamID: sid, ExitCode: -1})
					continue
				}
				sessMu.Lock()
				logStreams[sid] = stream
				sessMu.Unlock()
			case "log_stop":
				sessMu.Lock()
				stream := logStreams[m.StreamID]
				sessMu.Unlock()
				if stream != nil {
					stream.Close()
				}
			case "log_drains":
				fwd.SetDrains(ctx, m.Drains)
			case "capabilities":
				// Hub pushed an updated granted set → refresh the fail-closed allowlist live.
				cs.set(m.Capabilities)
			case "agent_update":
				// Same fail-closed order as command: verify the hub signature, then the capability.
				if !protocol.VerifySig(hubPub, protocol.CanonicalAgentUpdate(m.ReqID, m.TargetVersion, m.Image, m.Sha256, m.Capability), m.Sig) {
					fmt.Fprintln(os.Stderr, "rejected agent_update: invalid or missing hub signature")
					continue
				}
				if !cs.allows(m.Capability) {
					fmt.Fprintln(os.Stderr, "rejected agent_update: capability not allowed:", m.Capability)
					continue
				}
				apply, noop := selfupdate.ShouldApply(cfg.Version, m.TargetVersion)
				if noop {
					_ = send(protocol.AgentUpdateResult{Type: "agent_update_result", ReqID: m.ReqID, TargetVersion: m.TargetVersion, OK: true, Phase: "noop"})
					continue
				}
				if !apply {
					_ = send(protocol.AgentUpdateResult{Type: "agent_update_result", ReqID: m.ReqID, TargetVersion: m.TargetVersion, OK: false, Phase: "noop", Error: "target not newer than current"})
					continue
				}
				if !updating.CompareAndSwap(false, true) {
					continue // an update is already in flight
				}
				go func(reqID, targetVersion, image, sha256 string) {
					handedOff := false
					selfupdate.Apply(ctx, cfg.HubURL, image, sha256, func(ok bool, phase, errMsg string) {
						if ok && phase == "applying" {
							handedOff = true // helper launched; we'll be recreated shortly
						}
						_ = send(protocol.AgentUpdateResult{
							Type: "agent_update_result", ReqID: reqID, TargetVersion: targetVersion, OK: ok, Phase: phase, Error: errMsg,
						})
					})
					if !handedOff {
						updating.Store(false) // failed before handoff → allow a future retry
					}
				}(m.ReqID, m.TargetVersion, m.Image, m.Sha256)
			case "fs_req":
				// Same fail-closed order as command: verify the hub signature, then the capability.
				if !protocol.VerifySig(hubPub, protocol.CanonicalFs(m.ReqID, m.Op, m.Volume, m.Path, m.Capability), m.Sig) {
					fmt.Fprintln(os.Stderr, "rejected fs_req: invalid or missing hub signature")
					continue
				}
				if !cs.allows(m.Capability) {
					fmt.Fprintln(os.Stderr, "rejected fs_req: capability not allowed:", m.Capability)
					continue
				}
				go func(reqID, op, volume, path string) {
					// Fail closed: with no locally-configured agent image there is no helper to launch.
					if cfg.AgentImage == "" {
						_ = send(protocol.FsResult{Type: "fs_result", ReqID: reqID, OK: false, Error: "file operations are not configured on this agent"})
						return
					}
					c, cancel := context.WithTimeout(ctx, fsOpTimeout)
					defer cancel()
					entries, truncated, err := fsd.Launch(c, cfg.AgentImage, volume, op, path)
					if err != nil {
						_ = send(protocol.FsResult{Type: "fs_result", ReqID: reqID, OK: false, Error: err.Error()})
						return
					}
					_ = send(protocol.FsResult{Type: "fs_result", ReqID: reqID, OK: true, Entries: entries, Truncated: truncated})
				}(m.ReqID, m.Op, m.Volume, m.Path)
			}
		}
	}()

	// Per-container `docker stats` runs on its OWN goroutine. Collection can block for up to
	// statsTimeout on a slow/hung docker daemon, and it must never stall the host-metric/heartbeat
	// cadence below (a stalled heartbeat makes the server look stale). send() is mutex-guarded so
	// concurrent writes are safe; a failed send here is ignored — it's best-effort telemetry, and
	// the heartbeat loop is what detects a dead connection and tears it down. loopCtx (cancelled on
	// Run's return) stops this goroutine so it can't outlive the connection.
	loopCtx, cancelLoops := context.WithCancel(ctx)
	defer cancelLoops()
	go func() {
		csTicker := time.NewTicker(containerStatsInterval)
		defer csTicker.Stop()
		csColl := dockerstats.NewCollector() // owned solely by this goroutine → rate-delta state has no races
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-csTicker.C:
				if samples, err := csColl.Sample(loopCtx); err == nil && len(samples) > 0 {
					_ = send(protocol.ContainerMetrics{Type: "container_metrics", Ts: time.Now().UnixMilli(), Samples: samples})
				}
			}
		}
	}()

	// Visitor-traffic summaries get their OWN goroutine and ticker: tailing + aggregating the access log
	// must never run on the 5s heartbeat loop below. Best-effort send, same as container_metrics. The
	// collector is per-connection (dies with loopCtx) and starts at the end of an existing log, so a
	// reconnect never replays a window; the hub sums windows additively.
	go func() {
		tc := traffic.NewCollector()
		defer tc.Close()
		tTicker := time.NewTicker(trafficInterval)
		defer tTicker.Stop()
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-tTicker.C:
				tc.IngestNew()
				if sum := tc.Flush(); sum != nil {
					_ = send(*sum)
				}
			}
		}
	}()

	ticker := time.NewTicker(metricsInterval)
	defer ticker.Stop()
	coll := metrics.NewCollector()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-readerDone:
			return errors.New("connection closed by hub")
		case <-hostTicker.C:
			sendHostInfo()
		case <-ticker.C:
			if sample, err := coll.Sample(); err == nil {
				if err := send(protocol.Metrics{Type: "metrics", Sample: sample}); err != nil {
					return err
				}
			}
			if err := send(protocol.Heartbeat{Type: "heartbeat", Ts: time.Now().UnixMilli()}); err != nil {
				return err
			}
		}
	}
}

// interruptedMarker is appended to the re-sent result of a durable command that was running when the agent
// process itself died (its real outcome is unknown; the hub treats it like a hub-restart interruption).
const interruptedMarker = "TUGRA_INTERRUPTED: the agent restarted while this command was running; its result is unknown"

// allowsCapability reports whether the allowlist permits a capability. FAIL-CLOSED: an empty
// allowlist denies everything (deny-by-default). The bypass escape hatch lives in capState.
func allowsCapability(allowed []string, capability string) bool {
	for _, c := range allowed {
		if c == capability {
			return true
		}
	}
	return false
}

// capState holds the agent's live fail-closed capability allowlist. The hub is authoritative and
// pushes updates (in enrolled/auth_ok and the "capabilities" message). Reads happen on the reader
// goroutine while command handlers run on their own goroutines, so access is mutex-guarded.
type capState struct {
	mu     sync.RWMutex
	caps   []string
	bypass bool
}

func newCapState(caps []string, bypass bool) *capState {
	return &capState{caps: caps, bypass: bypass}
}

func (c *capState) set(caps []string) {
	c.mu.Lock()
	c.caps = caps
	c.mu.Unlock()
}

func (c *capState) allows(capability string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.bypass {
		return true // explicit --caps=all / TUGRA_CAPS=all operator escape
	}
	return allowsCapability(c.caps, capability)
}
