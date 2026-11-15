package fsd

import (
	"errors"
	"strings"
)

// knownOps is the allowlist of file operations the helper accepts. Validating here keeps an unexpected
// op from ever reaching the argv (and the subcommand dispatch), and mirrors RunCLI's own switch.
var knownOps = map[string]bool{"list": true}

// BuildHelperArgs builds the `docker run` argv that launches the sandboxed fsd helper: an ephemeral
// (--rm), network-less (--network none), read-only root (--read-only), capability-stripped
// (--cap-drop ALL, only DAC_READ_SEARCH added so root-in-container can still traverse), no-privilege-gain
// (--security-opt no-new-privileges), resource-bounded (--pids-limit, --memory) container, with ONLY the
// target volume mounted READ-ONLY at /data. It re-invokes the agent's OWN image (digest-pinned by the
// caller) with the `fsd` subcommand — no shell, so there is no command-injection surface. The image's
// entrypoint is overridden to the agent binary.
//
// It fail-closed VALIDATES every attacker-reachable field before emitting argv:
//   - volume must be a plain Docker named volume (validateVolume). This is the load-bearing check: it is
//     mounted with `--mount type=volume,src=<volume>`, which — unlike `-v <src>:/data` — can NEVER fall
//     back to a host bind mount from a path-like source, and the name charset forbids ':'/','/'=' so no
//     extra mount fields can be smuggled. A host-path escape ("/", "/etc", …) is therefore impossible.
//   - op must be in the known allowlist.
//   - image must not start with '-' (docker option injection) and must be non-empty.
//
// Trust model (both helper profiles, see also BuildHelperArgs2): the capabilities below only matter to an
// attacker who can already execute code inside the helper. The helper runs ONLY agent code (`fsd`/`fsd2`) with no
// shell, no network, a read-only root and a single named volume, so none of them is a usable primitive on its own.
//   - read profile (this function; fsd2 stat/read): DAC_READ_SEARCH only, volume mounted READ-ONLY.
//   - mutating profile (fsd2 write/mkdir/rename/chmod/delete): CHOWN + DAC_OVERRIDE + FOWNER and the volume
//     mounted READ-WRITE. That is real write power over ONE volume, so it is gated by the opt-in `files_write`
//     capability and the signed fs2 protocol, every path is os.Root-confined with symlinks refused, and the
//     real-docker suite (-tags dockerit) is the regression gate for these claims.
//
// name is a caller-generated container name (--name): it gives the launcher a handle to force-remove the
// daemon-owned container if the op times out (exec.CommandContext kills only the `docker run` CLI, not the
// container). It must match Docker's container-name charset.
func BuildHelperArgs(image, volume, op, path, name string) ([]string, error) {
	if err := validateVolume(volume); err != nil {
		return nil, err
	}
	if !knownOps[op] {
		return nil, errors.New("unsupported op")
	}
	if image == "" || strings.HasPrefix(image, "-") {
		return nil, errors.New("invalid image reference")
	}
	if !nameRe.MatchString(name) {
		return nil, errors.New("invalid container name")
	}
	return []string{
		"docker", "run", "--rm",
		"--name", name,
		"--network", "none",
		"--read-only",
		"--cap-drop", "ALL",
		"--cap-add", "DAC_READ_SEARCH",
		"--security-opt", "no-new-privileges",
		"--pids-limit", "64",
		"--memory", "128m",
		"--mount", "type=volume,src=" + volume + ",dst=/data,readonly,volume-nocopy",
		"--entrypoint", "tugra-agent",
		image,
		"fsd", op, path,
	}, nil
}
