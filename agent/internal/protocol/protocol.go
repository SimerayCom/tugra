// Package protocol mirrors the JSON message contract in packages/shared.
package protocol

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"strconv"
)

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
	// Hub signing: hubKey on enrolled/auth_ok; sig on command/term_start.
	HubKey string `json:"hubKey"`
	Sig    string `json:"sig"`
}

// CanonicalCommand mirrors @tugra/shared canonicalCommand (byte-identical input).
func CanonicalCommand(reqID, command string, timeoutMs int) string {
	return "cmd\n" + reqID + "\n" + command + "\n" + strconv.Itoa(timeoutMs)
}

// CanonicalTermStart mirrors @tugra/shared canonicalTermStart.
func CanonicalTermStart(sessionID, target string, cols, rows int) string {
	return "term\n" + sessionID + "\n" + target + "\n" + strconv.Itoa(cols) + "\n" + strconv.Itoa(rows)
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
