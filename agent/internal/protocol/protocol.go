// Package protocol mirrors the JSON message contract in packages/shared.
package protocol

const Version = 1

type MetricsSample struct {
	Ts        int64   `json:"ts"`
	CPU       float64 `json:"cpu"`
	MemUsed   float64 `json:"memUsed"`
	MemTotal  float64 `json:"memTotal"`
	DiskUsed  float64 `json:"diskUsed"`
	DiskTotal float64 `json:"diskTotal"`
	NetRx     float64 `json:"netRx"`
	NetTx     float64 `json:"netTx"`
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
}

type Metrics struct {
	Type   string        `json:"type"`
	Sample MetricsSample `json:"sample"`
}

type Heartbeat struct {
	Type string `json:"type"`
	Ts   int64  `json:"ts"`
}

// HostInfo is the host hardware/OS inventory (mirrors packages/shared HostInfo).
type HostInfo struct {
	OS            string `json:"os"`
	OSVersion     string `json:"osVersion"`
	Arch          string `json:"arch"`
	Kernel        string `json:"kernel"`
	CPUCores      int    `json:"cpuCores"`
	MemTotalBytes uint64 `json:"memTotalBytes"`
	BootTime      int64  `json:"bootTime"`
}

type HostInfoMsg struct {
	Type string   `json:"type"`
	Info HostInfo `json:"info"`
}

// CommandResult: Agent -> Hub, reply to a Command.
type CommandResult struct {
	Type     string `json:"type"`
	ReqID    string `json:"reqId"`
	ExitCode int    `json:"exitCode"`
	Output   string `json:"output"`
}

// Hub -> Agent (one struct covers all; unused fields stay empty)
type ServerMsg struct {
	Type     string `json:"type"`
	Nonce    string `json:"nonce"`
	ServerID string `json:"serverId"`
	Seal     string `json:"seal"`
	Message  string `json:"message"`
	ReqID    string `json:"reqId"`
	Command  string `json:"command"`
}
