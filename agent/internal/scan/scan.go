// Package scan is the read-only host scanner behind the hub's "Scan this server" report.
//
// The hub runs `tugra-agent scan` in a short-lived, capability-stripped helper container (the agent's own image)
// with the host filesystem mounted READ-ONLY at --root, the host PID namespace (so /proc lists host processes) and
// the host network (so /proc/net/tcp lists the host's listening sockets). The scanner never writes, never starts a
// process and never talks to a daemon: it only reads a fixed set of files (PM2 dumps, web-server vhosts, systemd
// unit names, panel marker paths). Every read is confined to --root (symlinks are re-anchored there), size-capped,
// and every value that leaves is control-character-stripped and length-capped. Secret VALUES are never read out:
// PM2 environment maps are reduced to a key count (plus a numeric PORT), systemd ExecStart arguments are dropped.
// Docker containers are collected hub-side through the agent's own docker socket, not here.
package scan

import (
	"encoding/json"
	"io"
	"strings"
)

// Version is the report schema version (the hub rejects a different one).
const Version = 1

const (
	maxPM2PerUser = 100
	maxPM2Users   = 50
	maxSites      = 150
	maxServices   = 60
	maxPorts      = 150
	maxStr        = 160
	maxFile       = 512 << 10 // largest config / dump file read
)

// Options configures a scan. The zero value is not usable; use DefaultOptions.
type Options struct {
	Root string // the host filesystem mount (default /host)
	Proc string // the process table (default /proc; /proc/net must be the HOST's, so run with --network host)
}

// DefaultOptions are the values the helper container uses.
func DefaultOptions() Options { return Options{Root: "/host", Proc: "/proc"} }

// Report is the scan result printed as one JSON document.
type Report struct {
	V        int       `json:"v"`
	Markers  []string  `json:"markers"`
	PM2      []PM2User `json:"pm2"`
	Sites    []Site    `json:"sites"`
	Services []Service `json:"services"`
	Ports    []Port    `json:"ports"`
	Errors   []string  `json:"errors"`
}

// PM2User is one account's PM2 home.
type PM2User struct {
	User   string    `json:"user"`
	Daemon bool      `json:"daemon"` // the PM2 daemon process is alive
	Procs  []PM2Proc `json:"procs"`
}

// PM2Proc is one process in a PM2 home. EnvCount is the number of environment variables (never their names or values).
type PM2Proc struct {
	Name      string `json:"name"`
	Script    string `json:"script,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	Mode      string `json:"mode,omitempty"` // fork | cluster
	Instances int    `json:"instances,omitempty"`
	Status    string `json:"status"` // online | stopped
	Port      int    `json:"port,omitempty"`
	EnvCount  int    `json:"envCount"`
}

// Site is one web-server virtual host.
type Site struct {
	Server   string   `json:"server"` // nginx | apache
	Names    []string `json:"names"`
	Root     string   `json:"root,omitempty"`
	Kind     string   `json:"kind"` // php | proxy | static | other
	Port     int      `json:"port,omitempty"`
	PHP      string   `json:"php,omitempty"`
	SSL      bool     `json:"ssl"`
	Panel    string   `json:"panel,omitempty"` // cloudpanel when the vhost belongs to it
	SiteUser string   `json:"siteUser,omitempty"`
}

// Service is a recognised web / runtime / database service from systemd, or a custom app unit.
type Service struct {
	Unit    string `json:"unit"`
	Kind    string `json:"kind"` // web | php | database | runtime | panel | tool | app
	Enabled bool   `json:"enabled"`
	Running *bool  `json:"running,omitempty"` // nil when it cannot be told from the process table
	Exec    string `json:"exec,omitempty"`    // app units: the executable's base name only
	WorkDir string `json:"workDir,omitempty"` // app units
}

// Port is one listening TCP port. Scope is "local" for loopback-only listeners.
type Port struct {
	Port  int    `json:"port"`
	Proto string `json:"proto"`
	Scope string `json:"scope"` // public | local
}

// Run collects everything. Each collector is independent: one failing adds a short code to Errors and the rest still run.
func Run(o Options) Report {
	if o.Root == "" {
		o.Root = "/host"
	}
	if o.Proc == "" {
		o.Proc = "/proc"
	}
	fs := newRootFS(o.Root)
	comms := processNames(o.Proc)
	r := Report{V: Version, Markers: []string{}, PM2: []PM2User{}, Sites: []Site{}, Services: []Service{}, Ports: []Port{}, Errors: []string{}}
	r.Markers = collectMarkers(fs)
	r.PM2 = collectPM2(fs, o.Proc, &r.Errors)
	r.Sites = collectSites(fs, hasMarker(r.Markers, "cloudpanel"), &r.Errors)
	r.Services = collectServices(fs, comms, &r.Errors)
	r.Ports = collectPorts(o.Proc, &r.Errors)
	return r
}

// RunCLI is the `scan` subcommand: flags --root and --proc, one JSON document on stdout, exit 0 (a partial
// report is still a report; the per-collector failures are inside it).
func RunCLI(args []string, stdout, stderr io.Writer) int {
	o := DefaultOptions()
	for _, a := range args {
		k, v, ok := strings.Cut(a, "=")
		if !ok {
			continue
		}
		switch k {
		case "--root":
			o.Root = v
		case "--proc":
			o.Proc = v
		}
	}
	if err := json.NewEncoder(stdout).Encode(Run(o)); err != nil {
		_, _ = io.WriteString(stderr, "scan: encode failed\n")
		return 1
	}
	return 0
}

func hasMarker(markers []string, id string) bool {
	for _, m := range markers {
		if m == id {
			return true
		}
	}
	return false
}

// clean strips control characters and caps the length of a value read off the host (untrusted).
func clean(s string, max int) string {
	if max <= 0 {
		max = maxStr
	}
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || (r >= 0x7f && r < 0xa0) {
			b.WriteByte(' ')
			continue
		}
		b.WriteRune(r)
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	if len(out) > max {
		out = strings.ToValidUTF8(out[:max], "")
	}
	return out
}
