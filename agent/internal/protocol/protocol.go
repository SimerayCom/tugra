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
	// Optional load average + swap — pointers so "host reported 0" (idle load, swap configured but
	// unused) stays on the wire, while "can't report" (unsupported OS, old agents) is ABSENT, never a
	// fake 0. SwapTotal is 0 on a host with no swap; consumers must guard the divide.
	Load1     *float64 `json:"load1,omitempty"`
	Load5     *float64 `json:"load5,omitempty"`
	Load15    *float64 `json:"load15,omitempty"`
	SwapUsed  *float64 `json:"swapUsed,omitempty"`  // bytes
	SwapTotal *float64 `json:"swapTotal,omitempty"` // bytes
	// Optional sensor metrics — nil / omitted when the host exposes none (most cloud VMs). A pointer
	// plus omitempty keeps "no sensor" ABSENT on the wire, never a misleading 0.
	Temp    *float64           `json:"temp,omitempty"`    // hottest CPU-ish sensor, °C
	Sensors map[string]float64 `json:"sensors,omitempty"` // per-sensor °C (detail view)
	Gpus    []GPUStat          `json:"gpus,omitempty"`
	Battery *Battery           `json:"battery,omitempty"`
}

// GPUStat is one GPU's live usage. Mem is in bytes; Temp/Power are 0 when the vendor doesn't report them.
type GPUStat struct {
	Name     string  `json:"name"`
	Util     float64 `json:"util"`     // 0-100 %
	MemUsed  float64 `json:"memUsed"`  // bytes
	MemTotal float64 `json:"memTotal"` // bytes
	Temp     float64 `json:"temp"`     // °C
	Power    float64 `json:"power"`    // watts
}

// Battery is the system battery (laptop / UPS hosts); nil on servers and VMs with none.
type Battery struct {
	Percent float64 `json:"percent"` // 0-100
	State   string  `json:"state"`   // Charging | Discharging | Full | Not charging | Unknown
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
	// Features are optional per-feature flags (e.g. FeatureCmdJournal). Additive: an older hub ignores them.
	Features []string `json:"features,omitempty"`
}

type Auth struct {
	Type      string `json:"type"`
	Protocol  int    `json:"protocol"`
	ServerID  string `json:"serverId"`
	Signature string `json:"signature"`
	// AgentVersion refreshes the hub's stored version on reconnect (e.g. after a self-update).
	AgentVersion string `json:"agentVersion,omitempty"`
	// Features are optional per-feature flags (e.g. FeatureCmdJournal). Additive: an older hub ignores them.
	Features []string `json:"features,omitempty"`
}

// FeatureCmdJournal: this agent journals `durable` commands on disk, keeps them running across a WebSocket drop,
// never re-runs a re-sent reqId, and answers command_status with command_state. Mirrors
// AGENT_FEATURE_CMD_JOURNAL in packages/shared.
const FeatureCmdJournal = "cmd_journal_v1"

// Features is the list this agent advertises in enroll/auth.
var Features = []string{FeatureCmdJournal}

// CommandState: Agent -> Hub, reply to command_status (what happened to a durable command).
type CommandState struct {
	Type       string `json:"type"` // "command_state"
	ReqID      string `json:"reqId"`
	State      string `json:"state"`    // running | done | interrupted | unknown
	ExitCode   int    `json:"exitCode"` // never omitted: a journaled exit 0 must reach the hub as 0, not as "absent"
	Output     string `json:"output,omitempty"`
	Killed     bool   `json:"killed,omitempty"`
	StartedAt  int64  `json:"startedAt,omitempty"`
	FinishedAt int64  `json:"finishedAt,omitempty"`
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

// TrafficPathStat is one path's request count + response bytes within a window.
type TrafficPathStat struct {
	P string `json:"p"`
	N int64  `json:"n"`
	B int64  `json:"b"`
}

// TrafficCountryStat is a per-country request count (reserved; empty until GeoIP).
type TrafficCountryStat struct {
	C string `json:"c"`
	N int64  `json:"n"`
}

// TrafficLatencyBucketsMs are the fixed latency histogram upper bounds in milliseconds (mirrors
// TRAFFIC_LATENCY_BUCKETS_MS in packages/shared). A latency array has len+1 = 14 counts, the last being the
// overflow (> 10000 ms); the hub recovers p95 by cumulative interpolation.
var TrafficLatencyBucketsMs = [...]int64{1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000}

// TrafficKeyCount is a dimension value (browser, OS, referrer host, city, anonymized network, ...) with its
// request count. Keys are locally derived labels, never a raw IP, User-Agent or Referer.
type TrafficKeyCount struct {
	K string `json:"k"`
	N int64  `json:"n"`
}

// TrafficBots splits a domain's requests into human and bot traffic.
type TrafficBots struct {
	Human int64 `json:"human"`
	Bot   int64 `json:"bot"`
}

// TrafficDomainStat is one host's aggregate for a window (mirrors packages/shared).
type TrafficDomainStat struct {
	Host      string               `json:"host"`
	Requests  int64                `json:"requests"`
	S2xx      int64                `json:"s2xx"`
	S3xx      int64                `json:"s3xx"`
	S4xx      int64                `json:"s4xx"`
	S5xx      int64                `json:"s5xx"`
	Bytes     int64                `json:"bytes"`
	Paths     []TrafficPathStat    `json:"paths"`
	Countries []TrafficCountryStat `json:"countries,omitempty"`

	// Additive, optional dimensions computed locally by the agent (aggregates only).
	Browsers  []TrafficKeyCount `json:"browsers,omitempty"`
	OS        []TrafficKeyCount `json:"os,omitempty"`
	Devices   []TrafficKeyCount `json:"devices,omitempty"`
	Referrers []TrafficKeyCount `json:"referrers,omitempty"`
	Cities    []TrafficKeyCount `json:"cities,omitempty"`
	Networks  []TrafficKeyCount `json:"networks,omitempty"`
	Bots      *TrafficBots      `json:"bots,omitempty"`
	Latency   []int64           `json:"latency,omitempty"` // len(TrafficLatencyBucketsMs)+1 counts
	Unique    string            `json:"unique,omitempty"`  // base64 of the 4096-byte HyperLogLog register array (p=12); registers only, never an address; empty = no visitors
}

// TrafficMetrics is the agent->hub per-window visitor traffic aggregate. The hub sums it additively (no
// dedupe), so windows must be disjoint and each sent at most once: never replay a window after a reconnect.
type TrafficMetrics struct {
	Type      string              `json:"type"`
	Ts        int64               `json:"ts"`
	WindowSec int                 `json:"windowSec"`
	Domains   []TrafficDomainStat `json:"domains"`
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
	Type     string `json:"type"`
	Nonce    string `json:"nonce"`
	ServerID string `json:"serverId"`
	Seal     string `json:"seal"`
	Message  string `json:"message"`
	// Code is an optional machine-readable reason on a rejection. "reenroll" is the ONLY signal that
	// tells an already-enrolled agent its stored identity is genuinely gone (server row deleted / never
	// enrolled) and a fresh enroll is the correct recovery. Absent on generic/transient rejections.
	Code      string `json:"code,omitempty"`
	ReqID     string `json:"reqId"`
	Command   string `json:"command"`
	TimeoutMs int    `json:"timeoutMs"`
	// Durable (type "command"): journal this command (see FeatureCmdJournal). NOT part of CanonicalCommand — the
	// signed fields are unchanged; it only toggles bookkeeping around the same command (LogStart.Service precedent).
	Durable bool `json:"durable,omitempty"`
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
	// File ops (type "fs_req"): Op (list/stat/read), Volume (docker volume), Path (volume-relative).
	Op     string `json:"op,omitempty"`
	Volume string `json:"volume,omitempty"`
	Path   string `json:"path,omitempty"`
}

// FsEntry: one listing entry (metadata only — never content; a symlink is reported, never dereferenced).
type FsEntry struct {
	Name  string `json:"name"`
	Type  string `json:"type"` // file | dir | symlink | other
	Size  int64  `json:"size"`
	Mode  string `json:"mode"`  // rwx permission string
	Mtime int64  `json:"mtime"` // unix seconds
}

// FsResult: Agent -> Hub, the result of an fs_req.
type FsResult struct {
	Type      string    `json:"type"` // "fs_result"
	ReqID     string    `json:"reqId"`
	OK        bool      `json:"ok"`
	Error     string    `json:"error,omitempty"`
	Entries   []FsEntry `json:"entries,omitempty"`
	Truncated bool      `json:"truncated,omitempty"` // true when the listing was capped (maxEntries)
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

// CanonicalCommandCancel mirrors @tugra/shared canonicalCommandCancel — signs just the reqId of the
// running command to kill.
func CanonicalCommandCancel(reqID string) string {
	return "ccancel\n" + reqID
}

// CanonicalCommandStatus mirrors @tugra/shared canonicalCommandStatus — signs just the reqId whose journaled
// state the hub asks for (read-only; nothing is ever re-run in response).
func CanonicalCommandStatus(reqID string) string {
	return "cstat\n" + reqID
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

// CanonicalFs mirrors @tugra/shared canonicalFs (byte-identical input).
func CanonicalFs(reqID, op, volume, path, capability string) string {
	return "fs\n" + reqID + "\n" + op + "\n" + volume + "\n" + path + "\n" + capability
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
