// Package config holds agent runtime config + persisted enrollment state.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type Config struct {
	HubURL    string
	Token     string
	Version   string
	KeyPath   string
	StatePath string
	// Capabilities the agent starts with before the hub pushes the authoritative set (on
	// enrolled/auth_ok). Enforcement is FAIL-CLOSED: empty = deny all. The hub keeps this in sync
	// live via the "capabilities" message, so this is only a pre-handshake bootstrap value.
	Capabilities []string
	// CapsBypass (--caps=all / TUGRA_CAPS=all) disables the fail-closed allowlist entirely — an
	// explicit operator/upgrade escape hatch. Persistent: the hub's pushed set never overrides it.
	CapsBypass bool
	// AgentImage (TUGRA_AGENT_IMAGE) is the agent's OWN digest-pinned image, re-invoked as the sandboxed
	// `fsd` helper for file operations (CASA-FILES). It is learned locally, never from the hub, so the hub
	// cannot substitute a malicious image. Empty ⇒ file operations are UNAVAILABLE (fail-closed); the
	// install/compose layer (INSTALL-1) sets it. Only ever used when the "files" capability is granted.
	AgentImage string
}

// Store persists what we learn at enrollment so reconnects use key auth.
type Store struct {
	ServerID string `json:"serverId"`
	Seal     string `json:"seal"`
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
