package hostinfo

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// The agent runs in a container on the default bridge network, so what it sees of itself (hostname, /etc/os-release,
// network interfaces) is the CONTAINER, not the server: a container id as hostname, the agent image's Debian, and a
// docker-bridge 172.17.x address. The host's real identity is read through the Docker daemon instead.

// dockerInfo is the subset of `docker info` the agent uses.
type dockerInfo struct {
	Name            string `json:"Name"`            // the host's hostname
	OperatingSystem string `json:"OperatingSystem"` // e.g. "Ubuntu 26.04.1 LTS"
	OSVersion       string `json:"OSVersion"`       // e.g. "26.04"
	KernelVersion   string `json:"KernelVersion"`
	ID              string `json:"ID"` // the Docker engine id
}

// HostOS is the host's identity as seen by the Docker daemon.
type HostOS struct {
	Hostname  string
	OS        string // lower-case distro id, e.g. "ubuntu"
	OSVersion string // e.g. "26.04"
	EngineID  string // the Docker engine id ("" when not a plausible id)
}

var versionRe = regexp.MustCompile(`(?:^|[^0-9.])(\d+(?:\.\d+){0,2})`)

// ParseOperatingSystem turns the daemon's OperatingSystem/OSVersion strings into a distro id + version.
// "Docker Desktop" (a VM, not the host) and empty values yield ok=false so the caller keeps its own reading.
func ParseOperatingSystem(operatingSystem, osVersion string) (id, version string, ok bool) {
	osName := strings.TrimSpace(operatingSystem)
	if osName == "" || strings.Contains(strings.ToLower(osName), "docker desktop") {
		return "", "", false
	}
	fields := strings.Fields(osName)
	id = strings.ToLower(fields[0])
	if id == "red" && len(fields) > 1 && strings.EqualFold(fields[1], "hat") {
		id = "rhel"
	}
	version = strings.TrimSpace(osVersion)
	if version == "" {
		if m := versionRe.FindStringSubmatch(osName); m != nil {
			version = m[1]
		}
	}
	return id, version, true
}

// DockerHostOS asks the Docker daemon who the host is. Best-effort: any error returns ok=false.
func DockerHostOS(ctx context.Context) (HostOS, bool) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "info", "--format", "{{json .}}").Output()
	if err != nil {
		return HostOS{}, false
	}
	return parseDockerInfo(out)
}

// parseDockerInfo reads the daemon's `docker info --format {{json .}}` answer. Pure.
func parseDockerInfo(out []byte) (HostOS, bool) {
	var di dockerInfo
	if err := json.Unmarshal(out, &di); err != nil {
		return HostOS{}, false
	}
	h := HostOS{Hostname: strings.TrimSpace(di.Name), EngineID: CleanEngineID(di.ID)}
	if id, ver, ok := ParseOperatingSystem(di.OperatingSystem, di.OSVersion); ok {
		h.OS, h.OSVersion = id, ver
	}
	if h.Hostname == "" && h.OS == "" && h.EngineID == "" {
		return HostOS{}, false
	}
	return h, true
}

var (
	engineIDRe  = regexp.MustCompile(`^[A-Za-z0-9:_-]{8,128}$`)
	machineIDRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// sshdFpRe is the text ssh-keygen prints for a SHA-256 key fingerprint: "SHA256:" and 43 unpadded base64 characters.
	sshdFpRe = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)
)

// CleanEngineID returns the Docker engine id when it looks like one (letters, digits, colon, dash, underscore; 8-128 chars), else "".
// The value is parsed from the daemon's own answer and is only ever compared for equality by the hub; it is not trusted further.
func CleanEngineID(id string) string {
	id = strings.TrimSpace(id)
	if !engineIDRe.MatchString(id) {
		return ""
	}
	return id
}

// CleanMachineIDHash returns the hashed machine id (64 lower-case hex) when it is one, else "". The installer writes it; the raw
// machine id never reaches the agent or the hub.
func CleanMachineIDHash(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	if !machineIDRe.MatchString(h) {
		return ""
	}
	return h
}

// CleanSSHHostKeyFp returns the fingerprint when it is one ("SHA256:" and 43 base64 characters), else "". It is the public key's hash,
// the same text `ssh-keygen -l` prints; the host's sshd private keys are never read.
func CleanSSHHostKeyFp(fp string) string {
	fp = strings.TrimSpace(fp)
	if !sshdFpRe.MatchString(fp) {
		return ""
	}
	return fp
}

// CleanSSHHostKeyFps keeps the well-formed fingerprints of a list, once each and in order, at most four (ed25519, ecdsa, rsa and one spare).
func CleanSSHHostKeyFps(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, f := range in {
		c := CleanSSHHostKeyFp(f)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
		if len(out) == 4 {
			break
		}
	}
	return out
}

var imageRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]*$`)

// HostIPArgs is the `docker run` argv for the short-lived helper that reads the HOST's interfaces: the agent's own
// image (already local, nothing pulled) on the host network, read-only, capability-stripped, no privileges, tiny
// limits, printing a JSON list of addresses and exiting.
func HostIPArgs(image string) ([]string, error) { return hostHelperArgs(image, "hostips") }

// HostMetaArgs is the same sandboxed helper running the `hostmeta` subcommand (cloud metadata public-IP lookup).
func HostMetaArgs(image string) ([]string, error) { return hostHelperArgs(image, "hostmeta") }

func hostHelperArgs(image, sub string) ([]string, error) {
	if image == "" || !imageRe.MatchString(image) {
		return nil, errors.New("invalid image reference")
	}
	return []string{
		"docker", "run", "--rm",
		"--network", "host",
		"--read-only",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", "16",
		"--memory", "32m",
		"--entrypoint", "tugra-agent",
		image,
		sub,
	}, nil
}

// HostReportedIPs runs the host-network helper and returns the host's interface addresses. Empty on any error
// (the caller falls back to what the container sees).
func HostReportedIPs(ctx context.Context, image string) []string {
	args, err := HostIPArgs(image)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, args[0], args[1:]...).Output()
	if err != nil {
		return nil
	}
	var ips []string
	if err := json.Unmarshal(out, &ips); err != nil {
		return nil
	}
	return ips
}

// HostCloudIPs runs the host-network helper's `hostmeta` subcommand: the IMDSv2 hop limit of 1 blocks a bridged
// container, the host network does not. Empty on any error.
func HostCloudIPs(ctx context.Context, image string) CloudIPs {
	args, err := HostMetaArgs(image)
	if err != nil {
		return CloudIPs{}
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, args[0], args[1:]...).Output()
	if err != nil {
		return CloudIPs{}
	}
	var c CloudIPs
	if err := json.Unmarshal(out, &c); err != nil {
		return CloudIPs{}
	}
	// Re-validate: the helper's output is parsed, not trusted.
	c.IPv4, c.IPv6 = publicIP(c.IPv4, false), publicIP(c.IPv6, true)
	if c.Empty() {
		return CloudIPs{}
	}
	return c
}

// PrintHostIPs is the `hostips` subcommand: run on the host network, it prints the interface IPs as JSON.
func PrintHostIPs() int {
	ips := reportedIps()
	if ips == nil {
		ips = []string{}
	}
	if err := json.NewEncoder(os.Stdout).Encode(ips); err != nil {
		return 1
	}
	return 0
}

// HostFacts is /etc/tugra/host-facts.json, written ON THE HOST by the installer (scripts/lib/hostfacts.sh).
type HostFacts struct {
	Source      string `json:"source"`
	CollectedAt int64  `json:"collectedAt"`
	Hostname    string `json:"hostname"`
	OS          string `json:"os"`
	OSVersion   string `json:"osVersion"`
	OSPretty    string `json:"osPretty"`
	// MachineIDHash is sha256("tugra-mid-v1" + /etc/machine-id) as hex, computed by the installer on the host.
	MachineIDHash string `json:"machineIdHash"`
	// SSHHostKeyFp / SSHHostKeyFps are the SHA-256 fingerprints of this machine's sshd HOST public keys (ed25519 first), computed by the
	// installer. The hub compares them with the key the Coolify host saw on the wire after an install over Coolify's SSH.
	SSHHostKeyFp  string   `json:"sshHostKeyFp"`
	SSHHostKeyFps []string `json:"sshHostKeyFps"`
	IPs           []string `json:"ips"`
}

// HostFactsPath is where the installer writes the host facts (the /etc/tugra mount is shared with the host).
var HostFactsPath = "/etc/tugra/host-facts.json"

// ReadHostFacts loads the installer-captured host facts; ok=false when absent or unreadable. Size-capped.
func ReadHostFacts(path string) (HostFacts, bool) {
	f, err := os.Open(path)
	if err != nil {
		return HostFacts{}, false
	}
	defer f.Close()
	var hf HostFacts
	if err := json.NewDecoder(io.LimitReader(f, 64<<10)).Decode(&hf); err != nil {
		return HostFacts{}, false
	}
	return hf, true
}
