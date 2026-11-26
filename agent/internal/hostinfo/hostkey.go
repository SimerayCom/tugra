package hostinfo

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// The sshd host key of the machine, read at runtime when the installer did not leave it in host-facts.json (an agent installed by an older
// installer, or by hand). The agent runs in a container and cannot see /etc/ssh, so a short-lived helper (the agent's own image, already
// local) gets exactly ONE public key file mounted read-only, no network, no capabilities, and prints its SHA-256 fingerprint. The private
// keys are never mounted and never read; only "SHA256:<43 chars>" comes back. The hub compares it with the key the Coolify host saw on the
// wire (the match step's "Same SSH host key").

// sshHostKeyTypes are the sshd host key files looked for, ed25519 first (the one OpenSSH offers first).
var sshHostKeyTypes = []string{"ed25519", "ecdsa", "rsa"}

// sshHostKeyDir is where sshd keeps its host keys on the host.
const sshHostKeyDir = "/etc/ssh"

// sshHostKeyMount is where the one public key file appears inside the helper.
const sshHostKeyMount = "/hostkey.pub"

// SSHHostKeyArgs is the `docker run` argv of the helper that fingerprints ONE host public key file: the agent's own image, no network, a
// read-only root, no capabilities, tiny limits, and only that public key file mounted read-only (a missing file makes docker refuse the
// mount, which the caller reads as "no such key").
func SSHHostKeyArgs(image, keyType string) ([]string, error) {
	if image == "" || !imageRe.MatchString(image) {
		return nil, errors.New("invalid image reference")
	}
	ok := false
	for _, t := range sshHostKeyTypes {
		if t == keyType {
			ok = true
		}
	}
	if !ok {
		return nil, errors.New("unknown host key type")
	}
	return []string{
		"docker", "run", "--rm",
		"--network", "none",
		"--read-only",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", "16",
		"--memory", "32m",
		"--mount", fmt.Sprintf("type=bind,source=%s/ssh_host_%s_key.pub,target=%s,readonly", sshHostKeyDir, keyType, sshHostKeyMount),
		"--entrypoint", "tugra-agent",
		image,
		"hostsshkey",
	}, nil
}

// SSHHostKeyFingerprint reads one OpenSSH public key line ("<type> <base64> [comment]") and returns the fingerprint ssh-keygen prints for it.
// ok=false for anything that is not a public key of a type sshd uses. Pure.
func SSHHostKeyFingerprint(line string) (string, bool) {
	f := strings.Fields(line)
	if len(f) < 2 {
		return "", false
	}
	switch f[0] {
	case "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521":
	default:
		return "", false
	}
	if len(f[1]) > 2000 {
		return "", false
	}
	blob, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil || len(blob) == 0 {
		return "", false
	}
	sum := sha256.Sum256(blob)
	return CleanSSHHostKeyFp("SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])), true
}

// PrintSSHHostKeyFp is the `hostsshkey` subcommand: inside the helper it fingerprints the one mounted public key and prints the result.
func PrintSSHHostKeyFp(path string, w io.Writer) int {
	f, err := os.Open(path)
	if err != nil {
		return 1
	}
	defer f.Close()
	line, _ := bufio.NewReader(io.LimitReader(f, 8<<10)).ReadString('\n')
	fp, ok := SSHHostKeyFingerprint(line)
	if !ok || fp == "" {
		return 1
	}
	fmt.Fprintln(w, fp)
	return 0
}

// HostSSHHostKeyFps runs the helper once per key type and returns the fingerprints of the keys the machine has. Empty on any error (the
// match then simply has no host key from this side; nothing is guessed).
func HostSSHHostKeyFps(ctx context.Context, image string) []string {
	var out []string
	for _, kt := range sshHostKeyTypes {
		args, err := SSHHostKeyArgs(image, kt)
		if err != nil {
			return nil
		}
		c, cancel := context.WithTimeout(ctx, 20*time.Second)
		b, err := exec.CommandContext(c, args[0], args[1:]...).Output()
		cancel()
		if err != nil {
			continue
		}
		if fp := CleanSSHHostKeyFp(strings.TrimSpace(string(b))); fp != "" {
			out = append(out, fp)
		}
	}
	return CleanSSHHostKeyFps(out)
}
