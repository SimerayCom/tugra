package client

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// drainSetter is the slice of drains.Forwarder the frame handler drives (an interface so tests use a fake).
type drainSetter interface {
	SetDrains(ctx context.Context, drains []protocol.DrainCfg)
	SetDrainsV2(ctx context.Context, drains []protocol.DrainCfg)
}

// drainFrames handles the hub's log-drain frames for ONE connection. It is only ever called from the single
// reader goroutine, so its state needs no lock.
type drainFrames struct {
	hubPub   ed25519.PublicKey
	serverID string // this agent's OWN stored server id: the signature is verified against it, never m.ServerID
	allows   func(capability string) bool
	fwd      drainSetter
	logf     func(format string, args ...any)

	lastRev  int64
	v2Active bool // once a signed v2 frame was accepted, unsigned legacy frames can never override it
}

func newDrainFrames(hubPub ed25519.PublicKey, serverID string, allows func(string) bool, fwd drainSetter) *drainFrames {
	return &drainFrames{hubPub: hubPub, serverID: serverID, allows: allows, fwd: fwd,
		logf: func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }}
}

// handleV2 verifies a "log_drains_v2" frame fail-closed (signature bound to this agent's server id, capability
// exactly "logs" and currently allowed, strictly increasing rev) before applying the full drain set.
func (d *drainFrames) handleV2(ctx context.Context, m protocol.ServerMsg) {
	if !protocol.VerifySig(d.hubPub, protocol.CanonicalLogDrains(d.serverID, m.Rev, m.DrainsJSON, m.Capability), m.Sig) {
		d.logf("rejected log_drains_v2: invalid or missing hub signature")
		return
	}
	if m.Capability != "logs" || !d.allows("logs") {
		d.logf("rejected log_drains_v2: capability not allowed: %s", m.Capability)
		return
	}
	if m.Rev <= d.lastRev {
		d.logf("rejected log_drains_v2: stale rev")
		return
	}
	var drs []protocol.DrainCfg
	if err := json.Unmarshal([]byte(m.DrainsJSON), &drs); err != nil {
		d.logf("rejected log_drains_v2: malformed drains")
		return
	}
	d.fwd.SetDrainsV2(ctx, drs)
	d.lastRev = m.Rev
	d.v2Active = true
}

// handleLegacy applies the unsigned legacy "log_drains" frame (sent by hubs older than log_drains_v2 and to agents
// that did not advertise it). It is ignored once a signed v2 set was accepted, and reduced to plain server-wide
// http/loki/datadog drains: scope/match/options/egress are dropped and NET types skipped, so an unsigned frame
// can never open a new egress path.
func (d *drainFrames) handleLegacy(ctx context.Context, m protocol.ServerMsg) {
	if d.v2Active {
		return
	}
	d.fwd.SetDrains(ctx, sanitizeLegacy(m.Drains))
}

// capabilitiesChanged is called after the granted set was refreshed: when `logs` is gone every v2 sink stops (the
// hub re-pushes after a re-grant with a higher rev).
func (d *drainFrames) capabilitiesChanged(ctx context.Context) {
	if !d.allows("logs") {
		d.fwd.SetDrainsV2(ctx, nil)
	}
}

func sanitizeLegacy(in []protocol.DrainCfg) []protocol.DrainCfg {
	out := make([]protocol.DrainCfg, 0, len(in))
	for _, d := range in {
		switch strings.ToLower(d.Type) {
		case "", "http", "loki", "datadog":
			out = append(out, protocol.DrainCfg{ID: d.ID, Type: d.Type, Endpoint: d.Endpoint, Token: d.Token})
		}
	}
	return out
}
