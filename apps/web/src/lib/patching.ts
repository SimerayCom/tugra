import type { UpgradablePackage } from "./types";

/** Packages whose upgrade restarts the container engine (dockerd / containerd / the OCI runtime) — and with it
 *  every container on the host. Exact names: `docker-ce-cli` and friends do not restart anything. */
const RUNTIME_PACKAGES = new Set(["docker-ce", "containerd.io", "runc"]);

export function isContainerRuntimePackage(name: string): boolean {
  return RUNTIME_PACKAGES.has(name);
}

/** Names of the pending updates that will restart every app on the server. Pure. */
export function containerRuntimeUpdates(packages: Pick<UpgradablePackage, "name">[]): string[] {
  return packages.map((p) => p.name).filter(isContainerRuntimePackage);
}
