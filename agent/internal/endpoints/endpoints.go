// Package endpoints keeps the agent's ordered list of hub endpoints.
//
// The agent starts with the single URL it was installed with (the bootstrap endpoint). The hub can later push a
// signed list (primary + fallbacks) so a change of the hub's public address (a panel domain set, changed or removed)
// never strands the agent. The list is persisted in the agent's state directory, so it survives restarts and a
// self-update. Everything here is pure data + file I/O: whether a list may be ACCEPTED (hub signature, anti-replay)
// is decided by the caller with the pinned hub key; this package only enforces the shape and the transport policy.
package endpoints

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// MaxEndpoints bounds a hub-pushed list (primary + a few fallbacks is all anyone needs).
const MaxEndpoints = 8

// PinPrefix is the only fingerprint scheme: sha256 of the hub certificate's DER, hex, e.g. "sha256:ab12...".
const PinPrefix = "sha256:"

// Endpoint is one hub address. URL is the WebSocket URL (wss://host/agent). Pin, when set, is the sha256 fingerprint of
// the leaf certificate the hub must present (a self-signed hub on a bare IP); without it the system roots decide.
type Endpoint struct {
	URL string `json:"url"`
	Pin string `json:"pin,omitempty"`
}

// State is what is persisted (~/.tugra/endpoints.json).
type State struct {
	// Bootstrap is the endpoint given at install (--hub / TUGRA_HUB). It is the last-resort fallback and the reset
	// point: re-running the installer with a different --hub starts over from it.
	Bootstrap Endpoint `json:"bootstrap"`
	// Insecure records the operator's explicit opt-in for plain ws:// (--hub-insecure), or a legacy plain-ws install
	// that was enrolled before this policy existed.
	Insecure bool `json:"insecure,omitempty"`
	// Rev is the revision of the last accepted hub list (anti-replay: a lower rev is refused).
	Rev int64 `json:"rev"`
	// List is the last accepted hub list, primary first. Empty until the hub pushes one.
	List []Endpoint `json:"list,omitempty"`
}

// Manager is the live, persisted endpoint list. Safe for concurrent use.
type Manager struct {
	mu   sync.Mutex
	path string
	st   State
}

// Open loads the persisted list and reconciles it with the bootstrap endpoint of this run. A path of "" keeps the
// state in memory only (tests). If the bootstrap differs from the persisted one the operator re-installed with a new
// address: the hub-pushed list is dropped and the list starts over from the new bootstrap.
func Open(path string, bootstrap Endpoint, insecure bool) (*Manager, error) {
	m := &Manager{path: path}
	var prev State
	if path != "" {
		if b, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(b, &prev)
		}
	}
	if prev.Bootstrap.URL == bootstrap.URL && prev.Bootstrap.Pin == bootstrap.Pin {
		m.st = prev
		m.st.Insecure = prev.Insecure || insecure
	} else {
		m.st = State{Bootstrap: bootstrap, Insecure: insecure}
	}
	if err := m.save(); err != nil {
		return m, err
	}
	return m, nil
}

// Order is the dial order: the primary first, then the fallbacks as the hub ranked them, then the bootstrap endpoint
// if the hub's list no longer names it. Duplicates (same URL) are dropped, first one wins.
func (m *Manager) Order() []Endpoint {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.orderNoLock()
}

// Primary is the endpoint always retried first.
func (m *Manager) Primary() Endpoint {
	if o := m.Order(); len(o) > 0 {
		return o[0]
	}
	return Endpoint{}
}

// Rev is the revision of the last accepted hub list (0 = none yet).
func (m *Manager) Rev() int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.st.Rev
}

// AllowPlain reports whether plain ws:// is permitted to non-internal hosts: only after the operator opted in at
// install (--hub-insecure) or for an install that was already enrolled over plain ws:// before this policy existed.
// A hub can therefore never talk an agent that installed over TLS down to plaintext.
func (m *Manager) AllowPlain() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.st.Insecure
}

// Bootstrap returns the install-time endpoint.
func (m *Manager) Bootstrap() Endpoint {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.st.Bootstrap
}

// ErrStaleRev is returned for a list older than the last accepted one (a replayed message).
var ErrStaleRev = errors.New("hub endpoint list is older than the one already accepted")

// Apply validates and persists a hub list that the caller has ALREADY verified against the pinned hub key. It reports
// whether the effective order changed. A list with a lower rev than the accepted one is refused (replay); an
// identical rev re-applies idempotently.
func (m *Manager) Apply(rev int64, list []Endpoint) (changed bool, err error) {
	clean, err := m.validate(list)
	if err != nil {
		return false, err
	}
	m.mu.Lock()
	if rev < m.st.Rev {
		m.mu.Unlock()
		return false, ErrStaleRev
	}
	before := orderOf(m.st)
	m.st.Rev = rev
	m.st.List = clean
	after := orderOf(m.st)
	err = m.saveLocked()
	m.mu.Unlock()
	return !equal(before, after), err
}

func orderOf(st State) []Endpoint {
	mm := Manager{st: st}
	return mm.orderNoLock()
}

func (m *Manager) orderNoLock() []Endpoint {
	var out []Endpoint
	seen := map[string]bool{}
	for _, e := range append(append([]Endpoint{}, m.st.List...), m.st.Bootstrap) {
		if e.URL == "" || seen[e.URL] {
			continue
		}
		seen[e.URL] = true
		out = append(out, e)
	}
	return out
}

func equal(a, b []Endpoint) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func (m *Manager) validate(list []Endpoint) ([]Endpoint, error) {
	if len(list) == 0 {
		return nil, errors.New("empty endpoint list")
	}
	if len(list) > MaxEndpoints {
		return nil, fmt.Errorf("too many endpoints (%d)", len(list))
	}
	plainOK := m.AllowPlain()
	var out []Endpoint
	seen := map[string]bool{}
	for _, e := range list {
		e.URL = strings.TrimSpace(e.URL)
		if err := CheckURL(e, plainOK); err != nil {
			return nil, err
		}
		if seen[e.URL] {
			continue
		}
		seen[e.URL] = true
		out = append(out, e)
	}
	return out, nil
}

func (m *Manager) save() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.saveLocked()
}

func (m *Manager) saveLocked() error {
	if m.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(m.path), 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(m.st)
	if err != nil {
		return err
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.path)
}

// IsPlain reports whether the URL is a plaintext ws:// (or http://) endpoint.
func IsPlain(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	s := strings.ToLower(u.Scheme)
	return s == "ws" || s == "http"
}

// IsLoopbackOrInternal reports a host that never leaves the machine / the docker network: loopback, localhost, or a
// single-label name (a compose service such as hub-api). Plain ws:// to these is the normal single-box setup.
func IsLoopbackOrInternal(host string) bool {
	h := strings.ToLower(strings.Trim(host, "[]"))
	if h == "localhost" {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback()
	}
	return !strings.Contains(h, ".") && h != ""
}

// CheckURL validates one endpoint's shape and transport policy.
//   - scheme wss (or ws when plainOK / loopback / internal); http(s) is refused (it is a WebSocket URL),
//   - a host is required, no userinfo,
//   - a pin must be "sha256:" + 64 hex chars and only makes sense for wss,
//   - wss to a bare IP needs a pin (no public CA issues certificates for IPs the hub could present).
func CheckURL(e Endpoint, plainOK bool) error {
	u, err := url.Parse(e.URL)
	if err != nil || u.Host == "" || u.Hostname() == "" {
		return fmt.Errorf("invalid hub endpoint %q", e.URL)
	}
	if u.User != nil {
		return fmt.Errorf("hub endpoint %q must not carry credentials", e.URL)
	}
	switch strings.ToLower(u.Scheme) {
	case "wss":
		if e.Pin == "" && net.ParseIP(u.Hostname()) != nil {
			return fmt.Errorf("hub endpoint %q is a bare IP over TLS and needs a certificate pin", e.URL)
		}
	case "ws":
		if e.Pin != "" {
			return fmt.Errorf("hub endpoint %q is plain ws:// and cannot be pinned", e.URL)
		}
		if !plainOK && !IsLoopbackOrInternal(u.Hostname()) {
			return fmt.Errorf("hub endpoint %q is plain ws:// and plaintext was not opted into at install (--hub-insecure)", e.URL)
		}
	default:
		return fmt.Errorf("hub endpoint %q: unsupported scheme %q", e.URL, u.Scheme)
	}
	if e.Pin != "" {
		if _, err := ParsePin(e.Pin); err != nil {
			return err
		}
	}
	return nil
}

// ParsePin decodes "sha256:<64 hex>" into the 32 raw bytes.
func ParsePin(pin string) ([]byte, error) {
	h := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(pin)), PinPrefix)
	if len(h) != 64 {
		return nil, fmt.Errorf("invalid certificate pin %q", pin)
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil, fmt.Errorf("invalid certificate pin %q", pin)
	}
	return b, nil
}

// NormalizePin lower-cases and prefixes a user-supplied fingerprint ("AB:CD:..." and bare hex both accepted).
func NormalizePin(raw string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(raw))
	s = strings.TrimPrefix(s, PinPrefix)
	s = strings.ReplaceAll(s, ":", "")
	if _, err := ParsePin(s); err != nil {
		return "", err
	}
	return PinPrefix + s, nil
}

// Fingerprint is the pin of a DER certificate.
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return PinPrefix + hex.EncodeToString(sum[:])
}

// ErrPinMismatch is returned when a pinned endpoint presents another certificate.
var ErrPinMismatch = errors.New("hub certificate does not match the pinned fingerprint")

// TLSConfig is the client TLS config for an endpoint: the system roots when there is no pin, otherwise the leaf
// certificate must hash to the pin (the standard chain check is replaced by the leaf pin, which is what a
// self-signed hub on a bare IP needs). onLeaf (may be nil) receives the verified leaf DER.
func TLSConfig(pin string, onLeaf func(der []byte)) (*tls.Config, error) {
	if pin == "" {
		return &tls.Config{MinVersion: tls.VersionTLS12}, nil
	}
	want, err := ParsePin(pin)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		// The default chain verification is replaced by the leaf pin below; nothing is accepted without it.
		InsecureSkipVerify: true, //nolint:gosec // pinned leaf, verified in VerifyPeerCertificate
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return ErrPinMismatch
			}
			got := sha256.Sum256(raw[0])
			if subtle.ConstantTimeCompare(got[:], want) != 1 {
				return ErrPinMismatch
			}
			if onLeaf != nil {
				onLeaf(raw[0])
			}
			return nil
		},
	}, nil
}

// HTTPClient is an *http.Client that dials the endpoint with its pin enforced (for the WebSocket dial and for the
// signed file-transfer relay on the same origin). No overall Timeout: a WebSocket and a transfer are long-lived.
func HTTPClient(pin string, onLeaf func(der []byte)) (*http.Client, error) {
	cfg, err := TLSConfig(pin, onLeaf)
	if err != nil {
		return nil, err
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.TLSClientConfig = cfg
	t.ResponseHeaderTimeout = 30 * time.Second
	return &http.Client{Transport: t, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}
