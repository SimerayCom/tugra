// Package protocol mirrors the JSON message contract in packages/shared.
package protocol

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"strconv"
)

// Version is the on-wire protocol version — must match PROTOCOL_VERSION in packages/shared.
// Bumped to 2 when the hub began pushing per-server capabilities (enrolled/auth_ok + "capabilities").
const Version = 2

type MetricsSample struct {
	Ts        int64   `json:"ts"`
	CPU       float64 `json:"cpu"`
	MemUsed   float64 `json:"memUsed"`
	MemTotal  float64 `json:"memTotal"`
	DiskUsed  float64 `json:"diskUsed"`
	DiskTotal float64 `json:"diskTotal"`
	NetRx     float64 `json:"netRx"`
	NetTx     float64 `json:"netTx"`
	DiskRead  float64 `json:"diskRead"`  // bytes/s (physical-disk read throughput)
	DiskWrite float64 `json:"diskWrite"` // bytes/s
}

// Agent -> Hub
type Enroll struct {
	Type         string `json:"type"`
	Protocol     int    `json:"protocol"`
	Token        string `json:"token"`
	PublicKey    string `json:"publicKey"`
	AgentVersion string `json:"agentVersion"`
	Hostname     string `json:"hostname"`
	Fingerprint  string `json:"fingerprint"`
}

type Auth struct {
	Type      string `json:"type"`
	Protocol  int    `json:"protocol"`
	ServerID  string `json:"serverId"`
	Signature string `json:"signature"`
	// AgentVersion refreshes the hub's stored version on reconnect (e.g. after a self-update).
	AgentVersion string `json:"agentVersion,omitempty"`
}

type Metrics struct {
	Type   string        `json:"type"`
	Sample MetricsSample `json:"sample"`
}

// ContainerStat is one container's resource usage. Net/block fields are RATES (B/s) the agent
// derives from cumulative deltas; name is the stable key (id changes on restart).
type ContainerStat struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	CPU      float64 `json:"cpu"`      // %
	MemUsed  float64 `json:"memUsed"`  // bytes
	MemTotal float64 `json:"memTotal"` // bytes
	MemPct   float64 `json:"memPct"`   // %
	NetRx    float64 `json:"netRx"`    // B/s
	NetTx    float64 `json:"netTx"`    // B/s
	BlkRead  float64 `json:"blkRead"`  // B/s
	BlkWrite float64 `json:"blkWrite"` // B/s
}

type ContainerMetrics struct {
	Type    string          `json:"type"`
	Ts      int64           `json:"ts"`
	Samples []ContainerStat `json:"samples"`
}

type Heartbeat struct {
	Type string `json:"type"`
	Ts   int64  `json:"ts"`
}

// HostInfo is the host hardware/OS inventory (mirrors packages/shared HostInfo).
type HostInfo struct {
	OS            string   `json:"os"`
	OSVersion     string   `json:"osVersion"`
	Arch          string   `json:"arch"`
	Kernel        string   `json:"kernel"`
	CPUCores      int      `json:"cpuCores"`
	MemTotalBytes uint64   `json:"memTotalBytes"`
	BootTime      int64    `json:"bootTime"`
	ReportedIps   []string `json:"reportedIps"` // non-virtual, non-loopback interface IPs (reconcile)
}

type HostInfoMsg struct {
	Type string   `json:"type"`
	Info HostInfo `json:"info"`
}

// CommandLog: Agent -> Hub, a chunk of a running command's combined output.
type CommandLog struct {
	Type  string `json:"type"`
	ReqID string `json:"reqId"`
	Chunk string `json:"chunk"`
}

// CommandResult: Agent -> Hub, reply to a Command.
type CommandResult struct {
	Type     string `json:"type"`
	ReqID    string `json:"reqId"`
	ExitCode int    `json:"exitCode"`
	Output   string `json:"output"`
}

// TermOutput: Agent -> Hub, a chunk of a terminal session's PTY output (base64).
type TermOutput struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
}

// TermExit: Agent -> Hub, a terminal session ended.
type TermExit struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	ExitCode  int    `json:"exitCode"`
}

// LogChunk: Agent -> Hub, a line of a container-log follow stream.
type LogChunk struct {
	Type     string `json:"type"`
	StreamID string `json:"streamId"`
	Chunk    string `json:"chunk"`
}

// LogExit: Agent -> Hub, a log stream ended (process exited or was cancelled).
type LogExit struct {
	Type     string `json:"type"`
	StreamID string `json:"streamId"`
	ExitCode int    `json:"exitCode"`
}

// AgentUpdateResult: Agent -> Hub, a pre-handoff self-update outcome. Success is signalled implicitly by
// the recreated agent reconnecting with a new agentVersion; this only reports early failures.
type AgentUpdateResult struct {
	Type          string `json:"type"`
	ReqID         string `json:"reqId"`
	TargetVersion string `json:"targetVersion"`
	OK            bool   `json:"ok"`
	Phase         string `json:"phase"`
	Error         string `json:"error,omitempty"`
}

// Hub -> Agent (one struct covers all; unused fields stay empty)
type ServerMsg struct {
	Type      string `json:"type"`
	Nonce     string `json:"nonce"`
	ServerID  string `json:"serverId"`
	Seal      string `json:"seal"`
	Message   string `json:"message"`
	ReqID     string `json:"reqId"`
	Command   string `json:"command"`
	TimeoutMs int    `json:"timeoutMs"`
	// Terminal session fields (term_start / term_input / term_resize / term_close)
	SessionID string `json:"sessionId"`
	Target    string `json:"target"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Data      string `json:"data"`
	// Hub signing: hubKey on enrolled/auth_ok; sig on command/term_start/log_start.
	HubKey     string `json:"hubKey"`
	Sig        string `json:"sig"`
	Capability string `json:"capability"`
	// Live container-log follow (log_start / log_stop): StreamID + Target (container) reuse Target above.
	StreamID string `json:"streamId"`
	Tail     int    `json:"tail"`
	Follow   bool   `json:"follow"`
	Since    string `json:"since"`  // docker --since window ("5m"/"1h"); "" = none
	Search   string `json:"search"` // server-side grep -iF filter; "" = none
	// Swarm apps: when true, Target is a `docker service` name and the agent follows `docker service logs`
	// (aggregated across replicas) instead of `docker logs`. NOT part of CanonicalLogStart — Target (the
	// sensitive value) is already signed, and this flag only toggles the subcommand on that same target, so
	// it stays backward-compatible (an old agent ignores it and runs `docker logs`, failing gracefully).
	Service bool `json:"service,omitempty"`
	// Granted capabilities pushed by the hub (on enrolled/auth_ok and the "capabilities" message);
	// the agent enforces them fail-closed (empty = deny all).
	Capabilities []string `json:"capabilities"`
	// Log drains (type "log_drains"): forward container logs to these sinks.
	Drains []DrainCfg `json:"drains"`
	// Self-update (type "agent_update"): pull Image pinned to Sha256, recreate onto TargetVersion.
	TargetVersion string `json:"targetVersion"`
	Image         string `json:"image"`
	Sha256        string `json:"sha256"`
}

// DrainCfg is one external log sink. Type selects the payload format: "http" (Tugra batch JSON, the default),
// "loki" (Grafana Loki push) or "datadog" (Datadog logs intake). Token is a Bearer for http/loki and the
// DD-API-KEY header for datadog.
type DrainCfg struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
}

// CanonicalCommand mirrors @tugra/shared canonicalCommand (byte-identical input).
func CanonicalCommand(reqID, command string, timeoutMs int, capability string) string {
	return "cmd\n" + reqID + "\n" + command + "\n" + strconv.Itoa(timeoutMs) + "\n" + capability
}

// CanonicalTermStart mirrors @tugra/shared canonicalTermStart.
func CanonicalTermStart(sessionID, target string, cols, rows int, capability string) string {
	return "term\n" + sessionID + "\n" + target + "\n" + strconv.Itoa(cols) + "\n" + strconv.Itoa(rows) + "\n" + capability
}

// CanonicalLogStart mirrors @tugra/shared canonicalLogStart (byte-identical input).
func CanonicalLogStart(streamID, target string, tail int, follow bool, since, search, capability string) string {
	f := "0"
	if follow {
		f = "1"
	}
	return "logs\n" + streamID + "\n" + target + "\n" + strconv.Itoa(tail) + "\n" + f + "\n" + since + "\n" + search + "\n" + capability
}

// CanonicalAgentUpdate mirrors @tugra/shared canonicalAgentUpdate (byte-identical input).
func CanonicalAgentUpdate(reqID, targetVersion, image, sha256, capability string) string {
	return "aupd\n" + reqID + "\n" + targetVersion + "\n" + image + "\n" + sha256 + "\n" + capability
}

// ParseHubKey decodes a base64 SPKI ed25519 public key (delivered at enroll/auth).
func ParseHubKey(spkiB64 string) (ed25519.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(spkiB64)
	if err != nil {
		return nil, err
	}
	pub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	key, ok := pub.(ed25519.PublicKey)
	if !ok {
		return nil, errNotEd25519
	}
	return key, nil
}

// VerifySig checks a base64 ed25519 signature over canonical with the hub key.
func VerifySig(pub ed25519.PublicKey, canonical, sigB64 string) bool {
	if pub == nil {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return false
	}
	return ed25519.Verify(pub, []byte(canonical), sig)
}

var errNotEd25519 = errString("hub key is not ed25519")

type errString string

func (e errString) Error() string { return string(e) }
