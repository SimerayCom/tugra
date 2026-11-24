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
	// HubNonce is a fresh agent-chosen nonce the hub signs back (ServerMsg.HubProof) to prove it holds the hub key.
	HubNonce string `json:"hubNonce,omitempty"`
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
	// HubNonce: see Enroll.HubNonce.
	HubNonce string `json:"hubNonce,omitempty"`
}

// FeatureCmdJournal: this agent journals `durable` commands on disk, keeps them running across a WebSocket drop,
// never re-runs a re-sent reqId, and answers command_status with command_state. Mirrors
// AGENT_FEATURE_CMD_JOURNAL in packages/shared.
const FeatureCmdJournal = "cmd_journal_v1"

// FeatureLogDrainsV2: this agent accepts the signed, `logs`-capability-gated "log_drains_v2" frame (per-app
// scope, container match, per-transport options, egress policy) and reports "drain_status". Mirrors
// AGENT_FEATURE_LOG_DRAINS_V2 in packages/shared. The three transport flags tell the hub which NET drain types
// this agent can deliver (a drain of a type the agent lacks is withheld and shown as "agent update required").
const (
	FeatureLogDrainsV2  = "log_drains_v2"
	FeatureDrainSyslog  = "log_drain_syslog_v1"
	FeatureDrainGelf    = "log_drain_gelf_v1"
	FeatureDrainFluentd = "log_drain_fluentd_v1"
)

// FeatureFs2: this agent understands the signed fs2_req file protocol (write-capable volume ops, container
// filesystem ops, bounded transfers). Mirrors AGENT_FEATURE_FS2 in packages/shared.
const FeatureFs2 = "fs2_v1"

// FeatureHubOriginEnv: this agent exports TUGRA_HUB_ORIGIN (derived from its OWN configured hub URL) to commands of
// the `backup` capability only, so a hub-built script can reach a signed relay path without the hub naming a host.
// Mirrors AGENT_FEATURE_HUB_ORIGIN_ENV in packages/shared.
const FeatureHubOriginEnv = "hub_origin_env_v1"

// FeatureHubEndpoints: this agent keeps an ordered, persisted list of hub endpoints, accepts the signed
// "hub_endpoints" frame, verifies the hub's identity proof (hubNonce -> hubProof) and reports "hub_endpoint_state".
// Mirrors AGENT_FEATURE_HUB_ENDPOINTS in packages/shared.
const FeatureHubEndpoints = "hub_endpoints_v1"

// Features is the list this agent advertises in enroll/auth.
var Features = []string{FeatureCmdJournal, FeatureLogDrainsV2, FeatureDrainSyslog, FeatureDrainGelf, FeatureDrainFluentd, FeatureFs2, FeatureHubOriginEnv, FeatureHubEndpoints}

// HubEndpointState: Agent -> Hub. Sent right after every successful handshake and as the reply to a "hub_endpoints"
// frame. It tells the hub which list revision the agent holds and which endpoint this very session is on, so the hub
// can show which agents have moved to a new address. Accepted/Error answer a pushed list (a refused one is reported,
// never silently dropped).
type HubEndpointState struct {
	Type     string `json:"type"` // "hub_endpoint_state"
	Rev      int64  `json:"rev"`
	Active   string `json:"active"`
	Primary  string `json:"primary"`
	Accepted bool   `json:"accepted"`
	Error    string `json:"error,omitempty"`
}

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
	// Meta carries the few container labels the hub uses to show a real app/project name instead of an
	// opaque id (Coolify-managed and compose containers). Omitted when the container has none.
	Meta *ContainerMeta `json:"meta,omitempty"`
}

// ContainerMeta is the allow-listed subset of a container's labels. Every value is length-capped by the
// agent; nothing else from the label set (env, commands, secrets in labels) ever leaves the host.
type ContainerMeta struct {
	Name     string `json:"name,omitempty"`     // coolify.name
	Resource string `json:"resource,omitempty"` // coolify.resourceName
	Project  string `json:"project,omitempty"`  // coolify.projectName
	Env      string `json:"env,omitempty"`      // coolify.environmentName
	Service  string `json:"service,omitempty"`  // com.docker.compose.service
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
	ReportedIps   []string `json:"reportedIps"`        // non-virtual, non-loopback interface IPs (reconcile)
	Hostname      string   `json:"hostname,omitempty"` // the HOST's hostname (from the Docker daemon)
	// Public addresses the cloud provider's link-local metadata service reports for this instance (no outbound
	// probe), and which provider answered. Omitted off-cloud.
	MetadataIps   []string `json:"metadataIps,omitempty"`
	CloudProvider string   `json:"cloudProvider,omitempty"`
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
	// Signed log-drain set (type "log_drains_v2"): Rev is monotonic per hub process, DrainsJSON the pre-serialised
	// JSON array of DrainCfg (signed byte-for-byte via CanonicalLogDrains). ServerID is signed too, but the agent
	// verifies against its OWN stored server id, never this field.
	Rev        int64  `json:"rev,omitempty"`
	DrainsJSON string `json:"drainsJson,omitempty"`
	// fs2_req additions (see Fs2Fields / CanonicalFs2). reqId, op, path, sha256, timeoutMs and capability reuse the
	// fields above (same JSON keys and types). Additive: every other message type leaves these empty.
	Scope   string `json:"scope,omitempty"`
	Subject string `json:"subject,omitempty"`
	Path2   string `json:"path2,omitempty"`
	Mode    string `json:"mode,omitempty"`
	Flags   string `json:"flags,omitempty"`
	Size    int64  `json:"size,omitempty"`
	IfMatch string `json:"ifMatch,omitempty"`
	Xfer    string `json:"xfer,omitempty"`
	Exp     int64  `json:"exp,omitempty"`
	// HubProof (enrolled/auth_ok): ed25519 signature, by the hub key, over CanonicalHubProof(challenge nonce, the agent's
	// HubNonce). The only thing that proves the endpoint just dialled is the hub and not something replaying its
	// public key. Absent from an older hub.
	HubProof string `json:"hubProof,omitempty"`
	// Signed endpoint list (type "hub_endpoints"): Rev (above) is monotonic; EndpointsJSON is the pre-serialised JSON
	// array of {url, pin?}, signed byte-for-byte via CanonicalHubEndpoints with the agent's OWN stored server id.
	EndpointsJSON string `json:"endpointsJson,omitempty"`
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

// FsStat mirrors @tugra/shared Fs2Stat: one filesystem object, never dereferencing a symlink.
type FsStat struct {
	Name       string `json:"name"`
	Type       string `json:"type"` // file | dir | symlink | other
	Size       int64  `json:"size"`
	Mode       string `json:"mode"` // octal permission bits, e.g. "0644"
	Mtime      int64  `json:"mtime"`
	MtimeNs    int64  `json:"mtimeNs"`
	UID        int    `json:"uid"`
	GID        int    `json:"gid"`
	Etag       string `json:"etag"` // "<size>-<mtimeNs>"
	LinkTarget string `json:"linkTarget,omitempty"`
	Uname      string `json:"uname,omitempty"`
	Gname      string `json:"gname,omitempty"`
}

// Fs2Result: Agent -> Hub, the result of an fs2_req. Code is one of the closed set in FS_ERROR_CODES.
type Fs2Result struct {
	Type      string    `json:"type"` // "fs2_result"
	ReqID     string    `json:"reqId"`
	OK        bool      `json:"ok"`
	Code      string    `json:"code,omitempty"`
	Error     string    `json:"error,omitempty"`
	Stat      *FsStat   `json:"stat,omitempty"`
	Entries   []FsEntry `json:"entries,omitempty"`
	Truncated bool      `json:"truncated,omitempty"`
	Bytes     int64     `json:"bytes,omitempty"`
	Sha256    string    `json:"sha256,omitempty"`
	Etag      string    `json:"etag,omitempty"`
	Created   bool      `json:"created,omitempty"`
}

// DrainCfg is one external log sink. Type selects the payload format: "http" (Tugra batch JSON, the default),
// "loki" (Grafana Loki push), "datadog" (Datadog logs intake), or — in a log_drains_v2 frame from a hub that knows
// the transport — "syslog" (RFC 5424), "gelf" (GELF 1.1) or "fluentd" (Forward). Token is a Bearer for http/loki,
// the DD-API-KEY header for datadog and the shared key for fluentd. Every field after Token is additive and
// omitempty, so a legacy "log_drains" frame decodes (and is re-encoded in tests) exactly as before.
type DrainCfg struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
	// Scope is "app" (Match is mandatory; an app drain with no match forwards NOTHING) or ""/"server".
	Scope string `json:"scope,omitempty"`
	// AppID is set for app-scope drains; it is only a record label (_app_id / app_id), never used for matching.
	AppID string      `json:"appId,omitempty"`
	Match *DrainMatch `json:"match,omitempty"`
	// Host is the sanitised server name used as the syslog HOST / GELF host / fluentd host label.
	Host    string        `json:"host,omitempty"`
	Options *DrainOptions `json:"options,omitempty"`
	// Egress is the dial policy computed by the hub: "public" (also blocks loopback/RFC1918/CGNAT/ULA), "any"
	// (blocks only metadata/link-local/unspecified/multicast) or "" (legacy unguarded http, as before).
	Egress string `json:"egress,omitempty"`
}

// DrainMatch is the hub-resolved container selector of a drain. A container matches when its name is in Names, or
// starts with any Prefixes entry, or starts with a SvcPrefixes entry followed ONLY by ASCII digits (a compose
// replica index), or matches any Globs entry (path.Match). Mirrors resolveAppMatch in the hub.
type DrainMatch struct {
	Names       []string `json:"names,omitempty"`
	Prefixes    []string `json:"prefixes,omitempty"`
	SvcPrefixes []string `json:"svcPrefixes,omitempty"`
	Globs       []string `json:"globs,omitempty"`
}

// DrainOptions are the per-transport options of a syslog/gelf/fluentd drain (never a secret).
type DrainOptions struct {
	Proto      string `json:"proto,omitempty"`      // udp | tcp | tls
	Framing    string `json:"framing,omitempty"`    // syslog tcp/tls: octet | newline
	Compress   string `json:"compress,omitempty"`   // gelf udp: none | gzip | zlib
	Tag        string `json:"tag,omitempty"`        // fluentd tag prefix
	AppName    string `json:"appName,omitempty"`    // syslog APP-NAME override
	CACert     string `json:"caCert,omitempty"`     // PEM bundle added to the system roots (tls only)
	ServerName string `json:"serverName,omitempty"` // TLS SNI/verification name (tls only)
	Facility   *int   `json:"facility,omitempty"`   // syslog facility 0..23 (default 16)
	RequireAck *bool  `json:"requireAck,omitempty"` // fluentd: wait for the {"ack":chunk} reply (default true)
}

// DrainStatus is one sink's delivery status (Agent -> Hub). No error text: only the enum class.
type DrainStatus struct {
	ID       string `json:"id"`
	State    string `json:"state"` // ok | error | idle | invalid
	ErrClass string `json:"errClass,omitempty"`
	Sent     int64  `json:"sent"`
	Dropped  int64  `json:"dropped"`
	// Truncated counts lines that WERE delivered but cut to the transport's size cap (syslog); omitted when zero.
	Truncated int64 `json:"truncated,omitempty"`
	LastOkAt  int64 `json:"lastOkAt,omitempty"` // unix ms
}

// DrainStatusMsg: Agent -> Hub, per-sink status every 30 s and on state change.
type DrainStatusMsg struct {
	Type   string        `json:"type"` // "drain_status"
	Drains []DrainStatus `json:"drains"`
}

// CanonicalLogDrains mirrors @tugra/shared canonicalLogDrains (byte-identical input). The agent verifies it with
// its OWN stored server id so a frame captured for another server (the hub key is fleet-wide) never verifies.
func CanonicalLogDrains(serverID string, rev int64, drainsJSON, capability string) string {
	return "ldrn\n" + serverID + "\n" + strconv.FormatInt(rev, 10) + "\n" + drainsJSON + "\n" + capability
}

// CanonicalHubEndpoints mirrors @tugra/shared canonicalHubEndpoints (byte-identical input). The agent verifies it with
// its OWN stored server id, so a list captured for another server (the hub key is fleet-wide) never verifies.
func CanonicalHubEndpoints(serverID string, rev int64, endpointsJSON string) string {
	return "hep\n" + serverID + "\n" + strconv.FormatInt(rev, 10) + "\n" + endpointsJSON
}

// CanonicalHubProof mirrors @tugra/shared canonicalHubProof: the challenge nonce the hub issued plus the nonce the
// agent chose, so a proof can neither be replayed on another connection nor precomputed.
func CanonicalHubProof(challenge, hubNonce string) string {
	return "hubid\n" + challenge + "\n" + hubNonce
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

// Fs2Fields are every signed field of an fs2_req, in canonical order (mirrors @tugra/shared Fs2Fields).
type Fs2Fields struct {
	ReqID      string
	Op         string
	Scope      string
	Subject    string
	Path       string
	Path2      string
	Mode       string
	Flags      string
	Size       int64
	Sha256     string
	IfMatch    string
	Xfer       string
	TimeoutMs  int
	Exp        int64
	Capability string
}

// CanonicalFs2 mirrors @tugra/shared canonicalFs2: "fs2\n" + the 15 fields in order, each `<utf8ByteLength>:<value>`,
// joined by "\n". Length-prefixing makes an embedded newline unable to forge or shift another field.
func CanonicalFs2(f Fs2Fields) string {
	parts := []string{
		f.ReqID, f.Op, f.Scope, f.Subject, f.Path, f.Path2, f.Mode, f.Flags,
		strconv.FormatInt(f.Size, 10), f.Sha256, f.IfMatch, f.Xfer,
		strconv.Itoa(f.TimeoutMs), strconv.FormatInt(f.Exp, 10), f.Capability,
	}
	out := "fs2\n"
	for i, p := range parts {
		if i > 0 {
			out += "\n"
		}
		out += strconv.Itoa(len(p)) + ":" + p
	}
	return out
}

// Capability names used by the fs2 matrix.
const (
	capFiles      = "files"
	capFilesWrite = "files_write"
	capTerminal   = "terminal"
)

// Fs2MutatingOp reports whether op changes state.
func Fs2MutatingOp(op string) bool {
	switch op {
	case "write", "mkdir", "rename", "chmod", "delete":
		return true
	}
	return false
}

// Fs2RequiredCaps mirrors @tugra/shared fs2RequiredCapabilities. The LAST element is the signed capability.
// An empty result means an unknown (scope, op) pair.
func Fs2RequiredCaps(scope, op string) []string {
	switch scope {
	case "volume":
		if op == "stat" || op == "read" {
			return []string{capFiles}
		}
		if Fs2MutatingOp(op) {
			return []string{capFiles, capFilesWrite}
		}
	case "container":
		if op == "list" || op == "stat" || op == "read" {
			return []string{capFiles, capTerminal}
		}
		if Fs2MutatingOp(op) {
			return []string{capFiles, capFilesWrite, capTerminal}
		}
	}
	return nil
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
