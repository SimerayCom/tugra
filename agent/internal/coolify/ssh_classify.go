package coolify

import "strings"

// ClassifySSHFailure maps what a failed ssh helper printed (stderr) and its exit status to one fixed wire code. The text itself is never
// kept or sent: it can name addresses, users and paths.
func ClassifySSHFailure(stderr string, exit int, timedOut bool) string {
	if timedOut {
		return "timeout"
	}
	s := strings.ToLower(stderr)
	has := func(subs ...string) bool {
		for _, x := range subs {
			if strings.Contains(s, x) {
				return true
			}
		}
		return false
	}
	switch {
	case has("remote host identification has changed", "host key verification failed", "offending key", "host key for"):
		return "hostkey_changed"
	case has("no such identity", "identity file", "load key", "no such file or directory") && has("key", "identity"):
		return "no_key_file"
	case has("permission denied (publickey", "permission denied, please try again", "too many authentication failures", "authentication failed", "no supported authentication methods"):
		return "auth_failed"
	case has("a terminal is required", "you must have a tty", "no tty present"):
		return "sudo_tty"
	case has("a password is required", "sudo: sorry", "is not in the sudoers", "may not run sudo"):
		return "needs_root"
	case has("permission denied while trying to connect to the docker", "got permission denied"):
		return "docker_perm"
	case has("docker: command not found", "docker: not found", "docker is required", "docker is not installed"):
		return "docker_missing"
	case has("unsupported arch", "no matching manifest"):
		return "arch_unsupported"
	case has("could not pull", "pull access denied", "manifest unknown", "toomanyrequests", "error response from daemon: get"):
		return "pull_failed"
	case has("connection timed out", "operation timed out", "connection refused", "no route to host", "network is unreachable", "could not resolve", "name or service not known", "connection reset", "connection closed by", "kex_exchange_identification", "banner exchange"):
		return "unreachable"
	}
	if exit == 255 {
		return "unreachable"
	}
	return "installer_failed"
}
