package coolify

import (
	"encoding/json"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Every docker invocation of this lane is built here, from validated values only, one argv element per value (no shell, so a value that
// starts with a dash or holds a space can never become an option or a second command). The golden tests pin the exact lists.

const (
	// CoolifyContainer and CoolifyDB are the fixed container names Coolify runs under; nothing the hub sends can name another.
	CoolifyContainer = "coolify"
	CoolifyDB        = "coolify-db"
	// knownHostEnv carries the one verified host key line into the ssh helper; the constant wrapper below writes it to a private tmpfs file.
	// The key is public; nothing secret travels in it. No volume is shared between runs, so no earlier run can leave a trust record behind.
	knownHostEnv   = "TUGRA_KNOWN_HOST"
	knownHostsFile = "/state/known_hosts"
	// sshWrapper writes the verified line, then replaces itself with ssh; every other value is an argv element after the "sh" name.
	sshWrapper = `umask 077; printf '%s\n' "$` + knownHostEnv + `" > ` + knownHostsFile + ` && exec ssh "$@"`

	psqlSh = `exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"`
	pgOpts = "-c default_transaction_read_only=on -c statement_timeout=20000 -c idle_in_transaction_session_timeout=20000"

	// coolifySSHMount is where Coolify's own container mounts its ssh directory (its keys live in the keys/ folder below).
	coolifySSHMount = "/var/www/html/storage/app/ssh"
)

// allowedKeyBases is the allow-list of host paths the key directory may come from. The default Coolify layout only; anything else is refused
// rather than mounted.
var allowedKeyBases = []string{"/data/coolify/ssh"}

var (
	helperNameRe = regexp.MustCompile(`^tugra-cssh-[a-f0-9]{8,32}$`)
	imageRe      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,300}$`)
	keyDirRe     = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,200}$`)
)

// ResolveArgs: `docker exec` of the read-only psql in Coolify's database container; the SQL goes on stdin.
func ResolveArgs() []string {
	return []string{"docker", "exec", "-i", "-e", "PGOPTIONS=" + pgOpts, CoolifyDB, "sh", "-c", psqlSh}
}

// InspectCoolifyArgs prints the mounts of the Coolify container (JSON), where the key directory is found.
func InspectCoolifyArgs() []string {
	return []string{"docker", "inspect", "--format", "{{json .Mounts}}", CoolifyContainer}
}

// KeyDirFromMounts finds the host directory holding Coolify's keys in `docker inspect` mounts JSON and checks it against the allow-list.
// It returns the keys folder (e.g. /data/coolify/ssh/keys), or a no_key_file error.
func KeyDirFromMounts(mountsJSON string) (string, error) {
	src, ok := findMountSource(mountsJSON, coolifySSHMount)
	if !ok {
		return "", fail("no_key_file", "Coolify's ssh directory is not mounted")
	}
	clean := path.Clean(src)
	if !keyDirRe.MatchString(clean) || strings.Contains(src, "..") || clean != src {
		return "", fail("no_key_file", "key directory path not allowed")
	}
	allowed := false
	for _, b := range allowedKeyBases {
		if clean == b {
			allowed = true
		}
	}
	if !allowed {
		return "", fail("no_key_file", "key directory is not on the allow-list")
	}
	return clean + "/keys", nil
}

// ScanArgs: ssh-keyscan from Coolify's network position. No key, no volume, nothing sent: it only learns which host keys the server offers.
func ScanArgs(image, name string, t Target) ([]string, error) {
	if err := checkHelper(image, name, t); err != nil {
		return nil, err
	}
	a := helperBase(name, false)
	a = append(a, "--entrypoint", "ssh-keyscan", image, "-T", "10", "-p", strconv.Itoa(t.Port), "-t", "ed25519,ecdsa,rsa", "--", t.Host)
	return a, nil
}

// KeyCheckArgs: `test -r` on the one key file, with the key directory mounted read-only. The file is never read into anything.
func KeyCheckArgs(image, name, keyDir string, t Target) ([]string, error) {
	if err := checkHelper(image, name, t); err != nil {
		return nil, err
	}
	if !keyDirRe.MatchString(keyDir) || strings.Contains(keyDir, "..") || strings.Contains(keyDir, ",") {
		return nil, fail("no_key_file", "key directory path not allowed")
	}
	a := helperBase(name, false)
	a = append(a, "--cap-add", "DAC_READ_SEARCH", "--mount", "type=bind,src="+keyDir+",dst=/keys,readonly",
		"--entrypoint", "test", image, "-r", "/keys/ssh_key@"+t.KeyUUID)
	return a, nil
}

// SSHArgs: the ssh helper. remote is the command run on the target (see RemoteCommand); the script arrives on stdin (-i). knownHost is the
// one verified host key line (see KnownHostLine); ssh runs with StrictHostKeyChecking=yes against a known_hosts holding only that line, so
// the key checked before the install is the key ssh itself insists on.
func SSHArgs(image, name, keyDir string, t Target, knownHost string, remote []string) ([]string, error) {
	if err := checkHelper(image, name, t); err != nil {
		return nil, err
	}
	if !knownHostLineRe.MatchString(knownHost) || !strings.HasPrefix(knownHost, t.UUID+" ") {
		return nil, fail("bad_target", "no verified host key to pin")
	}
	if !keyDirRe.MatchString(keyDir) || strings.Contains(keyDir, "..") || strings.Contains(keyDir, ",") {
		return nil, fail("no_key_file", "key directory path not allowed")
	}
	a := helperBase(name, true)
	a = append(a,
		"--tmpfs", "/state:rw,mode=0700,size=1m", "-e", "HOME=/state", "-e", knownHostEnv+"="+knownHost,
		"--cap-add", "DAC_READ_SEARCH",
		"--mount", "type=bind,src="+keyDir+",dst=/keys,readonly",
		"--entrypoint", "sh", image, "-c", sshWrapper, "sh",
		"-F", "/dev/null",
		"-i", "/keys/ssh_key@"+t.KeyUUID,
		"-o", "IdentitiesOnly=yes",
		"-o", "BatchMode=yes",
		"-o", "PasswordAuthentication=no",
		"-o", "KbdInteractiveAuthentication=no",
		"-o", "ConnectTimeout=15",
		"-o", "ServerAliveInterval=15",
		"-o", "ServerAliveCountMax=4",
		"-o", "StrictHostKeyChecking=yes",
		"-o", "UserKnownHostsFile="+knownHostsFile,
		"-o", "GlobalKnownHostsFile=/dev/null",
		"-o", "HostKeyAlias="+t.UUID,
		"-o", "ClearAllForwardings=yes",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
		"-o", "ControlMaster=no",
		"-o", "ControlPath=none",
		"-o", "LogLevel=ERROR",
		"-T",
		"-p", strconv.Itoa(t.Port),
		"--", t.User+"@"+t.Host,
	)
	a = append(a, remote...)
	return a, nil
}

// RemoteCommand is what the target runs: `sh -s` (the script comes on stdin), under `sudo -n` when the hub said so. extra are fixed words
// the caller validated (the image reference for an install).
func RemoteCommand(sudo bool, extra ...string) []string {
	cmd := []string{}
	if sudo {
		cmd = append(cmd, "sudo", "-n")
	}
	cmd = append(cmd, "sh", "-s", "--")
	return append(cmd, extra...)
}

// ValidImage reports whether ref is an image reference safe to put on a command line (never starts with a dash).
func ValidImage(ref string) bool { return imageRe.MatchString(ref) }

func checkHelper(image, name string, t Target) error {
	if !ValidImage(image) {
		return fail("installer_failed", "agent image is not configured")
	}
	if !helperNameRe.MatchString(name) {
		return fail("installer_failed", "invalid helper name")
	}
	if !uuidRe.MatchString(t.UUID) || !uuidRe.MatchString(t.KeyUUID) || !userRe.MatchString(t.User) || t.Port < 1 || t.Port > 65535 {
		return fail("bad_target", "invalid target")
	}
	if _, err := ValidateHost(t.Host); err != nil {
		return err
	}
	return nil
}

// helperBase is the common, locked-down head of every helper: it joins Coolify's network, drops every capability, has a read-only root and
// no way to gain privileges, and never pulls an image (the agent's own, already present).
func helperBase(name string, stdin bool) []string {
	a := []string{"docker", "run", "--rm"}
	if stdin {
		a = append(a, "-i")
	}
	return append(a,
		"--name", name,
		"--network", "container:"+CoolifyContainer,
		"--read-only",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", "64",
		"--memory", "128m",
		"--pull=never",
	)
}

type mount struct {
	Type        string `json:"Type"`
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
}

func findMountSource(mountsJSON, dst string) (string, bool) {
	var ms []mount
	if err := json.Unmarshal([]byte(strings.TrimSpace(mountsJSON)), &ms); err != nil {
		return "", false
	}
	for _, m := range ms {
		if m.Type == "bind" && m.Destination == dst && m.Source != "" {
			return m.Source, true
		}
	}
	return "", false
}
