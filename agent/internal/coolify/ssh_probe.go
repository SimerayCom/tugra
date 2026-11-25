package coolify

import (
	"strconv"
	"strings"

	"github.com/SimerayCom/tugra/agent/internal/protocol"
)

const probeLinePrefix = "TUGRA_PROBE "

// ProbeResult is what a probe printed. Complete is true only when the closing marker arrived: a truncated reply is "unknown", never "none".
type ProbeResult struct {
	Values   map[string]string
	Complete bool
}

// ParseProbe reads TUGRA_PROBE key=value lines out of noisy output (a login banner, motd). Anything else is ignored; a key's value is cut
// to a short length and limited to a plain character set so nothing the target prints can carry markup or a long payload.
func ParseProbe(out string) ProbeResult {
	r := ProbeResult{Values: map[string]string{}}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if !strings.HasPrefix(line, probeLinePrefix) {
			continue
		}
		kv := strings.TrimPrefix(line, probeLinePrefix)
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		k, v := kv[:i], kv[i+1:]
		if len(v) > 96 {
			v = v[:96]
		}
		v = strings.Map(func(c rune) rune {
			if c >= 0x21 && c <= 0x7e {
				return c
			}
			return -1
		}, v)
		if k == "end" && v == "1" {
			r.Complete = true
			continue
		}
		if _, dup := r.Values[k]; !dup {
			r.Values[k] = v
		}
	}
	return r
}

func yes(v string) *bool {
	var b bool
	switch v {
	case "yes":
		b = true
	case "no":
		b = false
	default:
		return nil
	}
	return &b
}

// Facts maps the printed values to the wire facts. A value that is missing or malformed stays absent (unknown).
func (r ProbeResult) Facts() *protocol.CoolifyProbeFacts {
	f := &protocol.CoolifyProbeFacts{}
	v := r.Values
	if n, err := strconv.Atoi(v["uid"]); err == nil && n >= 0 {
		f.UID = &n
	}
	f.DockerAccess = yes(v["docker_access"])
	if s := v["sudo"]; s == "yes" || s == "no" || s == "tty" || s == "none" {
		b := s == "yes"
		f.SudoNoPassword = &b
	}
	switch a := v["arch"]; a {
	case "x86_64", "amd64", "aarch64", "arm64":
		f.Arch = a
	}
	switch a := v["agent"]; a {
	case "none", "ours", "foreign_hub", "stopped":
		f.Agent = a
	}
	if n, err := strconv.Atoi(v["disk_mb"]); err == nil && n >= 0 {
		f.DiskFreeMb = &n
	}
	f.HubReachable = yes(v["hub"])
	if m := v["mid"]; len(m) == 64 && isHex(m) {
		f.MachineIDHash = m
	}
	if e := v["engine"]; e != "" && len(e) <= 80 {
		f.DockerEngineID = e
	}
	return f
}

func isHex(s string) bool {
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Verdict decides, from a complete probe, whether the install could proceed and the code that says why not. The order is the order a person
// would fix things in. A server that already has an agent is not a failure: it is `ok` with skipped_* so the hub leaves it alone.
func (r ProbeResult) Verdict() (ok bool, code string) {
	if !r.Complete {
		return false, "installer_failed"
	}
	v := r.Values
	switch v["agent"] {
	case "ours":
		return true, "skipped_present"
	case "foreign_hub":
		return true, "skipped_foreign"
	}
	switch v["arch"] {
	case "x86_64", "amd64", "aarch64", "arm64":
	default:
		return false, "arch_unsupported"
	}
	if v["docker_present"] != "yes" {
		return false, "docker_missing"
	}
	if v["uid"] != "0" && v["docker_access"] != "yes" {
		switch v["sudo"] {
		case "yes":
			if v["sudo_docker"] != "yes" {
				return false, "docker_perm"
			}
		case "tty":
			return false, "sudo_tty"
		default:
			return false, "needs_root"
		}
	}
	if v["uid"] == "0" && v["docker_access"] != "yes" {
		return false, "docker_perm"
	}
	if v["hub"] == "no" {
		return false, "hub_unreachable_from_target"
	}
	return true, "ok_installed"
}

// UseSudo reports whether the install must run under sudo: the user is not root and has no direct Docker access.
func (r ProbeResult) UseSudo() bool {
	return r.Values["uid"] != "0" && r.Values["docker_access"] != "yes"
}
