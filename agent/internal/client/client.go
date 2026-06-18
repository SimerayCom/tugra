// Package client runs the agent's outbound WebSocket session to the hub.
package client

import (
	"context"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/mrcandev/tugra/agent/internal/config"
	"github.com/mrcandev/tugra/agent/internal/exec"
	"github.com/mrcandev/tugra/agent/internal/hostinfo"
	"github.com/mrcandev/tugra/agent/internal/keys"
	"github.com/mrcandev/tugra/agent/internal/metrics"
	"github.com/mrcandev/tugra/agent/internal/protocol"
)

const (
	metricsInterval  = 5 * time.Second
	commandTimeout   = 20 * time.Second
	hostInfoInterval = 12 * time.Hour // refresh hardware/OS inventory periodically
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
			Type:      "auth",
			Protocol:  protocol.Version,
			ServerID:  store.ServerID,
			Signature: kp.SignBase64(challenge.Nonce),
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

	// Reader: handle commands from the hub.
	go func() {
		for {
			var m protocol.ServerMsg
			if err := wsjson.Read(ctx, conn, &m); err != nil {
				return
			}
			if m.Type == "command" {
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
			}
		}
	}()

	ticker := time.NewTicker(metricsInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-hostTicker.C:
			sendHostInfo()
		case <-ticker.C:
			if sample, err := metrics.Collect(); err == nil {
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
