package protocol

import "strconv"

// Coolify hub takeover, lane C: the signed frame that probes, installs or removes the Tugra agent on a server Coolify knows, and its
// result. The hub signs a coolify_ssh_req over the fields below; the agent verifies it before it touches Docker or SSH.

// CoolifySSHFields are the signed fields of a coolify_ssh_req, in canonical order (mirrors @tugra/shared CoolifySshFields).
type CoolifySSHFields struct {
	ReqID             string
	Op                string
	CoolifyServerUUID string
	ScriptSha256      string
	PayloadSha256     string
	UseSudo           bool
	ExpectedHostKeyFp string
	Exp               int64
	Capability        string
}

// CanonicalCoolifySSH mirrors @tugra/shared canonicalCoolifySsh: "cssh\n" + nine fields, each `<utf8ByteLength>:<value>`, joined by "\n".
func CanonicalCoolifySSH(f CoolifySSHFields) string {
	sudo := "0"
	if f.UseSudo {
		sudo = "1"
	}
	parts := []string{f.ReqID, f.Op, f.CoolifyServerUUID, f.ScriptSha256, f.PayloadSha256, sudo, f.ExpectedHostKeyFp, strconv.FormatInt(f.Exp, 10), f.Capability}
	out := "cssh\n"
	for i, p := range parts {
		if i > 0 {
			out += "\n"
		}
		out += strconv.Itoa(len(p)) + ":" + p
	}
	return out
}

// CoolifyProbeFacts mirrors @tugra/shared CoolifyProbeFacts. Pointers tell "not reported" from false/zero.
type CoolifyProbeFacts struct {
	UID            *int   `json:"uid,omitempty"`
	DockerAccess   *bool  `json:"dockerAccess,omitempty"`
	SudoNoPassword *bool  `json:"sudoNoPassword,omitempty"`
	Arch           string `json:"arch,omitempty"`
	Agent          string `json:"agent,omitempty"` // none | ours | foreign_hub | stopped
	DiskFreeMb     *int   `json:"diskFreeMb,omitempty"`
	HubReachable   *bool  `json:"hubReachable,omitempty"`
	SSHHostKeyFp   string `json:"sshHostKeyFp,omitempty"`
	HostKeyPinned  *bool  `json:"hostKeyPinned,omitempty"`
	MachineIDHash  string `json:"machineIdHash,omitempty"`
	DockerEngineID string `json:"dockerEngineId,omitempty"`
}

// CoolifySSHResult: Agent -> Hub, the outcome of one coolify_ssh_req. Fixed codes only: never a command line, a key path, an address or
// any output of the target.
type CoolifySSHResult struct {
	Type        string             `json:"type"` // "coolify_ssh_result"
	ReqID       string             `json:"reqId"`
	OK          bool               `json:"ok"`
	Code        string             `json:"code"`
	Probe       *CoolifyProbeFacts `json:"probe,omitempty"`
	ContainerID string             `json:"containerId,omitempty"`
	DurationMs  int64              `json:"durationMs,omitempty"`
}

// CoolifySSHCodes is the closed result-code set (mirrors COOLIFY_SSH_RESULT_CODES).
var CoolifySSHCodes = []string{
	"ok_installed", "skipped_present", "skipped_foreign", "unreachable", "auth_failed", "hostkey_changed", "hostkey_mismatch", "no_key_file",
	"bad_target", "needs_root", "sudo_tty", "docker_missing", "docker_perm", "arch_unsupported", "pull_failed", "hub_unreachable_from_target",
	"installer_failed", "enroll_timeout", "unsupported_proxy", "cancelled", "timeout",
}
