package coolify

import (
	"encoding/json"
	"errors"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

// Lane C: install the Tugra agent on the servers Coolify knows, over Coolify's own SSH keys. The key never leaves the Coolify host: it is
// read only by a short-lived helper container of the agent's own image, which has the key directory mounted read-only.

// SSHError is a failure that already has its fixed wire code (one of protocol.CoolifySSHCodes). Its message is for the agent's own log
// and never goes on the wire.
type SSHError struct {
	Code string
	Msg  string
}

func (e *SSHError) Error() string { return e.Code + ": " + e.Msg }

func fail(code, msg string) *SSHError { return &SSHError{Code: code, Msg: msg} }

// CodeOf returns the wire code of err, or fallback for an error that has none.
func CodeOf(err error, fallback string) string {
	var se *SSHError
	if errors.As(err, &se) {
		return se.Code
	}
	return fallback
}

var (
	uuidRe = regexp.MustCompile(`^[a-z0-9]{6,64}$`)
	userRe = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)
	hostRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)

	numericNameRe = regexp.MustCompile(`^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$`)
)

// ValidUUID reports whether s is a Coolify server uuid the agent accepts (it ends up inside a SQL literal and a known_hosts alias).
func ValidUUID(s string) bool { return uuidRe.MatchString(s) }

// Target is one Coolify-known server as the agent resolved it from Coolify's own `servers` table. It never holds key material: KeyUUID
// only names a key file.
type Target struct {
	UUID    string
	Host    string
	Port    int
	User    string
	KeyUUID string
	// PinnedHostKey is Coolify's own record of the server's SSH host key (server_settings.ssh_host_key, 4.7+), raw, "" when none.
	PinnedHostKey string
}

// TargetSQL is the one query that resolves a Coolify server. uuid must pass ValidUUID (the caller checks); it is the only spliced value and
// its charset cannot leave the quotes. Version-tolerant: columns that older Coolify lacks are read through to_jsonb and come back empty.
// It selects the key's uuid (a file name) and never the key itself.
func TargetSQL(uuid string) (string, error) {
	if !ValidUUID(uuid) {
		return "", fail("bad_target", "invalid server uuid")
	}
	return `select jsonb_build_object(
  'id', s.id,
  'ip', s.ip,
  'port', s.port,
  'user', s."user",
  'keyUuid', pk.uuid,
  'hostKey', coalesce(to_jsonb(ss)->>'ssh_host_key', ''),
  'tunnel', coalesce(to_jsonb(s)->>'is_cloudflare_tunnel', to_jsonb(ss)->>'is_cloudflare_tunnel', 'false'),
  'jump', coalesce(to_jsonb(s)->>'is_jump_server', to_jsonb(ss)->>'is_jump_server', 'false')
)::text
from servers s
left join server_settings ss on ss.server_id = s.id
left join private_keys pk on pk.id = s.private_key_id
where s.uuid = '` + uuid + `' and to_jsonb(s)->>'deleted_at' is null
limit 1;
`, nil
}

type targetRow struct {
	ID      *int64          `json:"id"`
	IP      string          `json:"ip"`
	Port    json.RawMessage `json:"port"`
	User    string          `json:"user"`
	KeyUUID string          `json:"keyUuid"`
	HostKey string          `json:"hostKey"`
	Tunnel  string          `json:"tunnel"`
	Jump    string          `json:"jump"`
}

// ParseTarget turns the psql output of TargetSQL into a validated Target. Fail-closed: a server Coolify does not have, Coolify's own
// "localhost" server, a tunnel or jump host, a missing key and any value that could be an option, a path or an unsafe address are all
// refused with a fixed code.
func ParseTarget(uuid, out string) (Target, error) {
	out = strings.TrimSpace(out)
	if out == "" {
		return Target{}, fail("bad_target", "not a server Coolify knows")
	}
	var row targetRow
	if err := json.Unmarshal([]byte(out), &row); err != nil {
		return Target{}, fail("bad_target", "unreadable server row")
	}
	if row.ID == nil || *row.ID == 0 {
		return Target{}, fail("bad_target", "this is Coolify's own server")
	}
	if row.Tunnel == "true" || row.Jump == "true" {
		return Target{}, fail("unsupported_proxy", "tunnel or jump host")
	}
	port := 22
	if s := strings.Trim(strings.TrimSpace(string(row.Port)), `"`); s != "" && s != "null" {
		n, err := strconv.Atoi(s)
		if err != nil {
			return Target{}, fail("bad_target", "invalid port")
		}
		port = n
	}
	if port < 1 || port > 65535 {
		return Target{}, fail("bad_target", "invalid port")
	}
	if !userRe.MatchString(row.User) {
		return Target{}, fail("bad_target", "invalid user")
	}
	host, err := ValidateHost(row.IP)
	if err != nil {
		return Target{}, err
	}
	if !uuidRe.MatchString(row.KeyUUID) {
		return Target{}, fail("no_key_file", "the server has no key")
	}
	return Target{UUID: uuid, Host: host, Port: port, User: row.User, KeyUUID: row.KeyUUID, PinnedHostKey: strings.TrimSpace(row.HostKey)}, nil
}

// ValidateHost returns the canonical host of a Coolify `ip` value, or a bad_target error. An address or a plain host name only: no option
// lookalike, no zone, no port, no path. Loopback, unspecified, link-local (the cloud metadata address included) and multicast are refused;
// private ranges are allowed (a Coolify on a private network reaches its servers there).
func ValidateHost(raw string) (string, error) {
	h := strings.TrimSpace(raw)
	h = strings.TrimPrefix(strings.TrimSuffix(h, "]"), "[")
	if len(h) > 1 && strings.HasSuffix(h, ".") && !strings.Contains(h, ":") {
		h = strings.TrimSuffix(h, ".")
	}
	if h == "" || len(h) > 253 || strings.HasPrefix(h, "-") {
		return "", fail("bad_target", "invalid address")
	}
	if strings.ContainsAny(h, " \t\r\n/\\@,;'\"`$|&<>*?(){}%") {
		return "", fail("bad_target", "invalid address")
	}
	if a, err := netip.ParseAddr(h); err == nil {
		a = a.Unmap()
		if a.IsLoopback() || a.IsUnspecified() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() || a.IsMulticast() || a.IsInterfaceLocalMulticast() {
			return "", fail("bad_target", "address not allowed")
		}
		return a.String(), nil
	}
	if strings.Contains(h, ":") || !hostRe.MatchString(h) {
		return "", fail("bad_target", "invalid address")
	}
	low := strings.ToLower(strings.TrimSuffix(h, "."))
	if low == "localhost" || strings.HasSuffix(low, ".localhost") || low == "host.docker.internal" || low == "gateway.docker.internal" || low == "metadata.google.internal" {
		return "", fail("bad_target", "address not allowed")
	}
	// An all-digit dotted name that is not a valid IPv4 literal (0x7f.1, 127.1) is parsed as an address by the resolver: refuse it.
	if numericNameRe.MatchString(low) {
		return "", fail("bad_target", "invalid address")
	}
	return low, nil
}
