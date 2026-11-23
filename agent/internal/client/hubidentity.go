package client

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/SimerayCom/tugra/agent/internal/config"
	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

// ErrHubKeyMismatch: the endpoint presented a hub signing key other than the one pinned at enroll.
var ErrHubKeyMismatch = errors.New("the hub presented a signing key that does not match the one pinned at enroll (refusing this endpoint; set TUGRA_HUB_REPIN=1 once to follow a hub whose HUB_SIGNING_KEY really changed)")

// newHubNonce is the agent's half of the hub identity proof.
func newHubNonce() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// hubIdentity is the outcome of checking an enrolled/auth_ok reply.
type hubIdentity struct {
	pub      []byte // parsed hub key (nil only for a legacy hub that sent none before anything was pinned)
	proofOK  bool   // the hub signed our fresh nonce with that key
	newlyPin bool   // the key was pinned (or re-pinned) by this handshake
}

// verifyHubIdentity decides whether the endpoint we just dialled is the hub we enrolled with.
//
//   - The hub key in the reply must equal the key pinned in the store (set at enroll / first auth). The first
//     handshake ever pins it (TOFU, as before). repin (explicit operator action, or a fresh enroll with a token the
//     operator just supplied) replaces the pin.
//   - A hubProof — the hub's signature over (the challenge it issued, the nonce we chose) — proves it HOLDS that
//     key rather than replaying its public value. Once a proof has been seen (store.HubProof) a reply without one is
//     refused, so the check cannot be downgraded; a hub-pushed endpoint (not the install-time one) always needs one.
//
// It does not persist anything: the caller commits the result with commitHubIdentity once the reply is accepted.
func verifyHubIdentity(store *config.Store, resp protocol.ServerMsg, challenge, hubNonce string, repin, learnedEndpoint bool) (hubIdentity, error) {
	var id hubIdentity
	if resp.HubKey == "" {
		if store.HubKey != "" {
			return id, errors.New("the hub did not present its signing key")
		}
		if learnedEndpoint {
			return id, errors.New("a hub-pushed endpoint must present the hub signing key")
		}
		return id, nil // a legacy hub with nothing pinned yet: behave as before (commands cannot verify, so none run)
	}
	pub, err := protocol.ParseHubKey(resp.HubKey)
	if err != nil {
		return id, fmt.Errorf("the hub presented an unusable signing key: %w", err)
	}
	if store.HubKey != "" && store.HubKey != resp.HubKey && !repin {
		return id, ErrHubKeyMismatch
	}
	id.pub = pub
	id.newlyPin = store.HubKey != resp.HubKey
	if resp.HubProof != "" {
		if !protocol.VerifySig(pub, protocol.CanonicalHubProof(challenge, hubNonce), resp.HubProof) {
			return id, errors.New("the hub identity proof is invalid (this endpoint is not the hub)")
		}
		id.proofOK = true
	} else if (store.HubProof && !repin) || learnedEndpoint {
		return id, errors.New("the hub did not prove its identity (no hubProof) — refusing this endpoint")
	}
	return id, nil
}

// commitHubIdentity persists what verifyHubIdentity accepted: the pinned key and the "proof seen" downgrade guard.
func commitHubIdentity(store *config.Store, resp protocol.ServerMsg, id hubIdentity) {
	changed := false
	if id.pub != nil && store.HubKey != resp.HubKey {
		store.HubKey = resp.HubKey
		changed = true
	}
	if id.proofOK && !store.HubProof {
		store.HubProof = true
		changed = true
	}
	if changed {
		_ = store.Save()
	}
}

// writeCACert stores the verified pinned leaf as PEM (0644: it is a public certificate) so curl in a backup
// command can use it as its only trust anchor. Best effort; written atomically.
func writeCACert(path string, der []byte) {
	if path == "" || len(der) == 0 {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}
