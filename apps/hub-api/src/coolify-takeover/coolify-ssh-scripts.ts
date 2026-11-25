import { renderAgentInstallScript } from "../install/agent-install-script";

/**
 * The scripts of the SSH install (Coolify hub takeover, lane C). The probe and the uninstall script live in the AGENT (agent/internal/coolify/
 * scripts) and the hub only names them by sha256: the agent runs its own copy and refuses any other, so a hub cannot make this path run a
 * script the agent does not carry. A spec reads those two files and checks the pins below, so an edit to a script that forgets the pin fails
 * here. The install script is the existing installer, rendered for this hub's release and wrapped so it is safe to feed over `sh -s`.
 */
export const COOLIFY_SSH_PROBE_SHA256 = "d631bbfdd452020001ef042ecc00b64c6145b0c82c7389be3d284d1a7b177fc7";
export const COOLIFY_SSH_UNINSTALL_SHA256 = "1aa1d75cc009875da04f266213c70d1faf270d3c613a506881af0b52ef11e886";

/** Printed by the wrapped installer once the container is started; the agent reads them from stdout. */
export const INSTALL_OK_MARK = "TUGRA_INSTALL_OK";
export const INSTALL_CID_MARK = "TUGRA_INSTALL_CID";

/**
 * The installer as a function: `sh -s` reads the script from stdin, and any command inside it that reads stdin (docker pull, a prompt) would
 * eat the rest of the script. Wrapped in a function the shell parses all of it first; the call at the end runs with stdin closed, and the
 * success marks are printed only when the whole installer exited 0 (a stream cut short never half-runs: the call line is the last).
 * The enroll token is NOT in this text: the agent prepends `export TUGRA_TOKEN=...` on stdin.
 */
export function renderCoolifySshInstallScript(image: string): string {
  const body = renderAgentInstallScript({ image })
    .split("\n")
    .filter((l, i) => !(i === 0 && l.startsWith("#!")))
    .join("\n")
    .trimEnd();
  return [
    "tugra_install_main() {",
    body,
    "}",
    'tugra_install_main "$@" </dev/null',
    `printf '${INSTALL_CID_MARK} %s\\n' "$(docker inspect -f '{{.Id}}' tugra-agent 2>/dev/null)"`,
    `echo ${INSTALL_OK_MARK}`,
    "",
  ].join("\n");
}
