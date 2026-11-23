// Package config holds agent runtime config + persisted enrollment state.
package config

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/SimerayCom/tugra/agent/internal/endpoints"
	"github.com/SimerayCom/tugra/agent/internal/journal"
)

type Config struct {
	// HubURL is the endpoint THIS session dials (the supervisor sets it per attempt from the endpoint list); HubPin is
	// that endpoint's leaf-certificate pin ("" = trust the system roots).
	HubURL string
	HubPin string
	// Endpoints is the persisted ordered hub endpoint list (nil in tests = single fixed URL, no rotation).
	Endpoints *endpoints.Manager
	// IsFallback: this session is on an endpoint other than the primary, so the session periodically checks whether
	// the primary is reachable again (ProbePrimary) and returns to it.
	IsFallback   bool
	ProbePrimary func(ctx context.Context) bool
	// IsBootstrap: this session dials the install-time endpoint. Only there is a hub "reenroll" honoured, so a
	// hub-pushed (learned) endpoint can never make the agent resend its enroll token.
	IsBootstrap bool
	// CACertPath is where the pinned hub leaf certificate is written (PEM) after a verified connection, so shell
	// commands (curl) of the backup capability can trust the same self-signed hub (exported as TUGRA_HUB_CACERT).
	CACertPath string
	// RepinHubKey (TUGRA_HUB_REPIN=1) accepts a different hub signing key once and pins it — the explicit way to
	// follow a hub whose HUB_SIGNING_KEY changed. Without it a different key is refused.
	RepinHubKey bool
	Token       string
	Version     string
	KeyPath     string
	StatePath   string
	// Capabilities the agent starts with before the hub pushes the authoritative set (on
	// enrolled/auth_ok). Enforcement is FAIL-CLOSED: empty = deny all. The hub keeps this in sync
	// live via the "capabilities" message, so this is only a pre-handshake bootstrap value.
	Capabilities []string
	// CapsBypass (--caps=all / TUGRA_CAPS=all) disables the fail-closed allowlist entirely — an
	// explicit operator/upgrade escape hatch. Persistent: the hub's pushed set never overrides it.
	CapsBypass bool
	// AgentImage (TUGRA_AGENT_IMAGE) is the agent's OWN digest-pinned image, re-invoked as the sandboxed
	// `fsd` helper for file operations. It is learned locally, never from the hub, so the hub
	// cannot substitute a malicious image. Empty ⇒ file operations are UNAVAILABLE (fail-closed); the
	// install/compose layer (INSTALL-1) sets it. Only ever used when the "files" capability is granted.
	AgentImage string
	// Journal is the process-level durable command journal (protocol feature cmd_journal_v1). nil = a
	// per-connection memory-only registry (tests); main.go passes one rooted at ~/.tugra/journal so journaled
	// commands and their results survive a hub restart or a WebSocket drop.
	Journal *journal.Registry
}

// Store persists what we learn at enrollment so reconnects use key auth.
type Store struct {
	ServerID string `json:"serverId"`
	Seal     string `json:"seal"`
	// HubKey is the hub's ed25519 signing key (base64 SPKI) pinned at enroll / first auth. Every endpoint — the
	// install-time one and each hub-pushed one — must present this key; a different key is refused.
	HubKey string `json:"hubKey,omitempty"`
	// HubProof: the hub has proven key possession once (hubNonce -> hubProof). From then on a connection without a
	// valid proof is refused, so a peer that only replays the public key cannot downgrade the check.
	HubProof bool `json:"hubProof,omitempty"`
	path     string
}

func LoadStore(path string) (*Store, error) {
	s := &Store{path: path}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, s)
		s.path = path
	}
	return s, nil
}

func (s *Store) Save() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, b, 0o600)
}
