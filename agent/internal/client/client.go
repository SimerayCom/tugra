// Package client runs the agent's outbound WebSocket session to the hub.
package client

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/mrcandev/tugra/agent/internal/config"
	"github.com/mrcandev/tugra/agent/internal/dockerstats"
	"github.com/mrcandev/tugra/agent/internal/drains"
	"github.com/mrcandev/tugra/agent/internal/exec"
	"github.com/mrcandev/tugra/agent/internal/hostinfo"
	"github.com/mrcandev/tugra/agent/internal/keys"
	"github.com/mrcandev/tugra/agent/internal/logs"
	"github.com/mrcandev/tugra/agent/internal/metrics"
	"github.com/mrcandev/tugra/agent/internal/protocol"
	"github.com/mrcandev/tugra/agent/internal/selfupdate"
	"github.com/mrcandev/tugra/agent/internal/terminal"
)

const (
	metricsInterval        = 5 * time.Second
	containerStatsInterval = 15 * time.Second // per-container `docker stats` — slower than host metrics
	commandTimeout         = 20 * time.Second
	hostInfoInterval       = 12 * time.Hour // refresh hardware/OS inventory periodically
)

// Run dials the hub, authenticates (enroll or reconnect), then streams metrics
// + heartbeats and executes commands until the context is cancelled.
func Run(ctx context.Context, cfg config.Config, kp *keys.KeyPair, store *config.Store) error {
	conn, _, err := websocket.Dial(ctx, cfg.HubURL, nil)
	if err != nil {
		return err
	}
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

	if store.ServerID != "" {
		if err := send(protocol.Auth{
			Type:         "auth",
			Protocol:     protocol.Version,
			ServerID:     store.ServerID,
			Signature:    kp.SignBase64(challenge.Nonce),
			AgentVersion: cfg.Version, // refresh the hub's stored version on reconnect (e.g. after self-update)
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
		return fmt.Errorf("authentication rejected: %s", resp.Message)
	}

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
	var sessMu sync.Mutex
	var updating atomic.Bool // single-flight: ignore duplicate agent_update messages once one is in flight
	go func() {
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
				go func(reqID, command string, timeoutMs int) {
					to := commandTimeout
					if timeoutMs > 0 {
						to = time.Duration(timeoutMs) * time.Millisecond
					}
					r := exec.RunStreaming(ctx, command, to, func(chunk string) {
						_ = send(protocol.CommandLog{
							Type:  "command_log",
							ReqID: reqID,
							Chunk: chunk,
						})
					})
					_ = send(protocol.CommandResult{
						Type:     "command_result",
						ReqID:    reqID,
						ExitCode: r.ExitCode,
						Output:   r.Output,
					})
				}(m.ReqID, m.Command, m.TimeoutMs)
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
				stream, err := logs.Start(m.Target, m.Tail, m.Since, m.Follow, m.Search,
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

	ticker := time.NewTicker(metricsInterval)
	defer ticker.Stop()
	coll := metrics.NewCollector()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
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
