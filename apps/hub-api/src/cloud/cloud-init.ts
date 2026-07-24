/**
 * Builds the cloud-init user-data run on a freshly-provisioned VM's first boot. A user-data script
 * that starts with `#!` is executed directly by cloud-init (no YAML). It installs Docker (the Tugra
 * agent installer hard-fails without it), then runs the exact enroll one-liner from ServersService.
 *
 * SECURITY: `installCommand` carries only the short-lived (1h, single-use) enroll token — the cloud
 * provider API token must NEVER reach this function or the VM.
 */
export function buildCloudInitUserData(installCommand: string): string {
  if (!installCommand.trim()) throw new Error("installCommand must not be empty");
  return [
    "#!/bin/sh",
    "# Tugra cloud-init bootstrap — installs Docker, then enrolls this VM as a Tugra server.",
    "set -eu",
    "",
    "curl -fsSL https://get.docker.com | sh",
    "",
    installCommand,
    "",
  ].join("\n");
}
