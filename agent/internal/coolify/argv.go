package coolify

import (
	"errors"
	"regexp"
)

// Every docker command line of the secrets pipeline is built here, from constants and from fields that were validated first. A user value
// is always ONE argv element in `--key=value` form, so a leading '-' can never be read as an option. None of these lines carries a
// secret: the app key and the rows travel on stdin, never on argv or in the environment.

// Fixed container names: Coolify's own containers, never a name taken from a request.
const (
	coolifyContainer = "coolify"
	coolifyDBName    = "coolify-db"
)

const (
	psqlOptions = "-c default_transaction_read_only=on -c statement_timeout=20000 -c idle_in_transaction_session_timeout=20000"
	psqlRun     = `exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"`
	// keyScript prints APP_KEY then APP_PREVIOUS_KEYS, one per line, from the container's environment or, failing that, its .env file.
	keyScript = `k="${APP_KEY:-}"; p="${APP_PREVIOUS_KEYS:-}"; ` +
		`[ -n "$k" ] || k=$(sed -n 's/^APP_KEY=//p' /var/www/html/.env 2>/dev/null | head -n 1); ` +
		`[ -n "$p" ] || p=$(sed -n 's/^APP_PREVIOUS_KEYS=//p' /var/www/html/.env 2>/dev/null | head -n 1); ` +
		`printf '%s\n%s\n' "$k" "$p"`
)

var (
	imageRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$`)
	nameRe   = regexp.MustCompile(`^tugra-coolify-open-[a-f0-9]{16}$`)
	runIDRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	pubKeyRe = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)
)

// PsqlArgv is stage A: a read-only psql session inside coolify-db; the SQL arrives on stdin.
func PsqlArgv() []string {
	return []string{"docker", "exec", "-i", "-e", "PGOPTIONS=" + psqlOptions, coolifyDBName, "sh", "-c", psqlRun}
}

// KeyArgv is stage B: print the app key on stdout (it goes straight to the helper's stdin).
func KeyArgv() []string {
	return []string{"docker", "exec", coolifyContainer, "sh", "-c", keyScript}
}

// HelperArgv is stage C: the sandbox the decryption and sealing run in. No network, read-only root, every capability dropped, no
// volume, no environment variable, no docker socket, no host namespace; the image is the agent's own (TUGRA_AGENT_IMAGE) and is never
// pulled. The container log driver is off so the daemon keeps no copy of the output.
func HelperArgv(image, name, runID, serverID, recipientB64 string) ([]string, error) {
	if !imageRe.MatchString(image) {
		return nil, errors.New("invalid image reference")
	}
	if !nameRe.MatchString(name) {
		return nil, errors.New("invalid container name")
	}
	if !runIDRe.MatchString(runID) || !runIDRe.MatchString(serverID) {
		return nil, errors.New("invalid id")
	}
	if !pubKeyRe.MatchString(recipientB64) {
		return nil, errors.New("invalid recipient key")
	}
	return []string{
		"docker", "run", "--rm", "-i", "--name", name,
		"--network", "none", "--read-only", "--cap-drop", "ALL",
		"--security-opt", "no-new-privileges", "--pids-limit", "32", "--memory", "128m",
		"--pull=never", "--log-driver", "none",
		"--entrypoint", "tugra-agent", image, "coolify-open",
		"--run=" + runID, "--server=" + serverID, "--recipient=" + recipientB64,
	}, nil
}

// RemoveArgv force-removes a helper container by its validated name (used after a cancelled run).
func RemoveArgv(name string) ([]string, error) {
	if !nameRe.MatchString(name) {
		return nil, errors.New("invalid container name")
	}
	return []string{"docker", "rm", "-f", name}, nil
}
