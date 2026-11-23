package client

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/endpoints"
	"github.com/SimerayCom/tugra/agent/internal/keys"
	"github.com/coder/websocket"
)

// maxBackoff caps the delay between full rotations through the endpoint list.
const maxBackoff = 30 * time.Second

// runner is one hub session (Run in production; a fake in the rotation tests).
type runner func(ctx context.Context, cfg config.Config, kp *keys.KeyPair, store *config.Store, onReady func()) error

// Supervise keeps the agent connected to a hub for as long as ctx lives.
//
// Each round dials the endpoint list in order — the PRIMARY first, then the fallbacks the hub ranked, then the
// install-time address — and stays on the first one that completes the handshake (which includes proving the hub's
// identity, see verifyHubIdentity). When a session ends the next round starts again from the primary, so a fallback is
// only ever used while the primary is down. A round in which every endpoint failed waits with exponential backoff
// (1s .. 30s) before the next one; a session that was established and then dropped reconnects after 1s, and a
// hub-pushed primary change or a recovered primary reconnects immediately.
func Supervise(ctx context.Context, base config.Config, kp *keys.KeyPair, store *config.Store, mgr *endpoints.Manager) {
	superviseWith(ctx, base, kp, store, mgr, Run, sleepCtx)
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func superviseWith(ctx context.Context, base config.Config, kp *keys.KeyPair, store *config.Store, mgr *endpoints.Manager, run runner, wait func(context.Context, time.Duration)) {
	backoff := time.Second
	// A primary that accepts the WebSocket upgrade but then fails the real handshake (pin / key mismatch, a CDN in
	// front, the hub rejecting us) must not make the agent drop a healthy fallback session over and over: every
	// failed return to the primary pushes the next probe out (doubling, capped).
	var probeAfter time.Time
	probeFails := 0
	backFromProbe := false
	for ctx.Err() == nil {
		order := mgr.Order()
		if len(order) == 0 {
			log.Println("no hub endpoint configured")
			wait(ctx, backoff)
			continue
		}
		primary := order[0]
		established, immediate := false, false
		for i, ep := range order {
			if ctx.Err() != nil {
				return
			}
			cfg := base
			cfg.Endpoints = mgr
			cfg.HubURL, cfg.HubPin = ep.URL, ep.Pin
			cfg.IsFallback = i > 0
			cfg.IsBootstrap = ep.URL == mgr.Bootstrap().URL
			cfg.ProbePrimary = func(c context.Context) bool {
				if time.Now().Before(probeAfter) {
					return false
				}
				return probeEndpoint(c, primary)
			}
			ready := false
			err := run(ctx, cfg, kp, store, func() {
				ready = true
				backoff = time.Second
				// The one log line of a successful (re)connect: `install.sh --doctor` reads it to tell a healthy agent from one
				// whose last logged event is an old failure.
				log.Printf("hub session on %s established", ep.URL)
			})
			if ctx.Err() != nil {
				return
			}
			if i == 0 {
				switch {
				case ready:
					probeFails, probeAfter = 0, time.Time{}
				case backFromProbe:
					probeFails++
					d := primaryProbeInterval << min(probeFails, 5)
					if d > maxProbeBackoff {
						d = maxProbeBackoff
					}
					probeAfter = time.Now().Add(d)
				}
				backFromProbe = false
			}
			if ready {
				established = true
				immediate = errors.Is(err, errEndpointSwitch) || errors.Is(err, errPrimaryBack)
				backFromProbe = errors.Is(err, errPrimaryBack)
				log.Printf("hub session on %s ended: %v", ep.URL, err)
				break
			}
			log.Printf("hub endpoint %s: %v", ep.URL, err)
		}
		switch {
		case immediate:
			// reconnect right away, primary first
		case established:
			wait(ctx, time.Second)
		default:
			log.Printf("no hub endpoint reachable; retrying in %s", backoff)
			wait(ctx, backoff)
			if backoff *= 2; backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

// probeEndpoint reports whether the endpoint accepts a WebSocket upgrade (no authentication is attempted, so it can
// neither supersede the live session nor leak anything). The same pin / transport rules as a real dial apply.
func probeEndpoint(ctx context.Context, ep endpoints.Endpoint) bool {
	httpc, err := endpoints.HTTPClient(ep.Pin, nil)
	if err != nil {
		return false
	}
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	conn, _, err := websocket.Dial(dctx, ep.URL, &websocket.DialOptions{HTTPClient: httpc})
	if err != nil {
		return false
	}
	_ = conn.Close(websocket.StatusNormalClosure, "probe")
	return true
}
