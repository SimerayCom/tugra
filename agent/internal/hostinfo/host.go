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
}

// HostOS is the host's identity as seen by the Docker daemon.
type HostOS struct {
	Hostname  string
	OS        string // lower-case distro id, e.g. "ubuntu"
	OSVersion string // e.g. "26.04"
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
	var di dockerInfo
	if err := json.Unmarshal(out, &di); err != nil {
		return HostOS{}, false
	}
	h := HostOS{Hostname: strings.TrimSpace(di.Name)}
	if id, ver, ok := ParseOperatingSystem(di.OperatingSystem, di.OSVersion); ok {
		h.OS, h.OSVersion = id, ver
	}
	if h.Hostname == "" && h.OS == "" {
		return HostOS{}, false
	}
	return h, true
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
	Source      string   `json:"source"`
	CollectedAt int64    `json:"collectedAt"`
	Hostname    string   `json:"hostname"`
	OS          string   `json:"os"`
	OSVersion   string   `json:"osVersion"`
	OSPretty    string   `json:"osPretty"`
	IPs         []string `json:"ips"`
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
