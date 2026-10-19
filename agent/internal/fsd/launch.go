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
// DAC_READ_SEARCH only matters to an attacker who can already execute code inside the helper; the helper
// runs ONLY this list code with no shell, no network and a read-only root, so it is not a usable primitive.
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
