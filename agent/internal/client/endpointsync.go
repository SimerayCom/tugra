package client

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/endpoints"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// errEndpointSwitch ends a session because the hub pushed a new primary: the supervisor redials, primary first.
var errEndpointSwitch = errors.New("hub endpoint list changed; reconnecting to the new primary")

// errPrimaryBack ends a session on a fallback endpoint because the primary answers again.
var errPrimaryBack = errors.New("primary hub endpoint is reachable again; returning to it")

// primaryProbeInterval is how often a session on a fallback endpoint checks whether the primary is back.
var primaryProbeInterval = 2 * time.Minute

// bootstrapURL / bootstrapPin are what a self-update passes on as TUGRA_HUB / TUGRA_HUB_PIN: always the install-time
// endpoint, never a hub-pushed one, so the recreated agent recognises its own persisted list and keeps it.
func bootstrapURL(cfg config.Config) string {
	if cfg.Endpoints != nil {
		if b := cfg.Endpoints.Bootstrap(); b.URL != "" {
			return b.URL
		}
	}
	return cfg.HubURL
}

func bootstrapPin(cfg config.Config) string {
	if cfg.Endpoints != nil {
		if b := cfg.Endpoints.Bootstrap(); b.URL != "" {
			return b.Pin
		}
	}
	return cfg.HubPin
}

// commandEnvFor is commandEnv plus, for a pinned (self-signed) hub, the path of its pinned certificate so a `backup`
// command's curl trusts exactly that certificate and nothing else.
func commandEnvFor(cfg config.Config, capability string) []string {
	env := commandEnv(cfg.HubURL, capability)
	if env != nil && capability == "backup" && cfg.HubPin != "" && cfg.CACertPath != "" {
		if _, err := os.Stat(cfg.CACertPath); err == nil {
			env = append(env, "TUGRA_HUB_CACERT="+cfg.CACertPath)
		}
	}
	return env
}

// handleHubEndpoints applies a signed "hub_endpoints" frame. Order matters and is fail-closed:
//
//  1. the signature must verify against the PINNED hub key, over the agent's OWN server id (a frame signed for another
//     server never verifies) — a forged or unsigned frame changes nothing;
//  2. the list must be well-formed and transport-safe (see endpoints.Manager.Apply) and not older than the accepted one;
//  3. only then is it persisted, and the session is told to redial when the primary changed.
//
// The result is always reported back (accepted or why not), so the hub never has to guess.
func handleHubEndpoints(cfg config.Config, store *config.Store, hubPub ed25519.PublicKey, proofOK bool, m protocol.ServerMsg, send func(any) error, switchReq chan<- struct{}) {
	if cfg.Endpoints == nil {
		return
	}
	reply := func(accepted bool, why string) {
		_ = send(protocol.HubEndpointState{
			Type: "hub_endpoint_state", Rev: cfg.Endpoints.Rev(), Active: cfg.HubURL,
			Primary: cfg.Endpoints.Primary().URL, Accepted: accepted, Error: why,
		})
	}
	if !protocol.VerifySig(hubPub, protocol.CanonicalHubEndpoints(store.ServerID, m.Rev, m.EndpointsJSON), m.Sig) {
		fmt.Fprintln(os.Stderr, "rejected hub_endpoints: invalid or missing hub signature")
		reply(false, "invalid signature")
		return
	}
	var list []endpoints.Endpoint
	if err := json.Unmarshal([]byte(m.EndpointsJSON), &list); err != nil {
		fmt.Fprintln(os.Stderr, "rejected hub_endpoints: malformed list")
		reply(false, "malformed list")
		return
	}
	changed, err := cfg.Endpoints.Apply(m.Rev, list)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rejected hub_endpoints:", err)
		reply(false, err.Error())
		return
	}
	// A hub that signs endpoint lists also proves its identity: from now on a reply without a proof is refused.
	if proofOK && !store.HubProof {
		store.HubProof = true
		_ = store.Save()
	}
	reply(true, "")
	if changed && cfg.Endpoints.Primary().URL != cfg.HubURL {
		select {
		case switchReq <- struct{}{}:
		default:
		}
	}
}
