import type { MigratorService, AdoptableContainer } from "../../migrator/migrator.service";
import type { ForeignApp, ForeignFleet, ForeignVolume } from "../foreign-fleet";
import type { ImportSource, ImportSourceCapabilities, FetchedSecrets } from "../import-source";

/**
 * Pure: map the migrator's discovered foreign containers on one host into a neutral {@link ForeignFleet}.
 * Only STANDALONE (non-compose) containers are importable here — compose-managed ones have no compose file
 * to reconstruct from a `docker inspect`, so they are reported as a skip and left to the source-PaaS adapters
 * (Coolify/Dokploy/…). Env VALUES are already blanked by the migrator's discover; only keys are carried.
 */
export function containersToFleet(serverId: string, containers: AdoptableContainer[]): ForeignFleet {
  const importable = containers.filter((c) => c.adoptable);
  const composeManaged = containers.length - importable.length;

  const apps: ForeignApp[] = importable.map((c) => ({
    sourceRef: c.id,
    name: c.name,
    kind: "image",
    buildPack: "image",
    image: c.image,
    imageOrigin: "registry",
    serverRef: serverId,
    ports: c.ports.map((p) => p.container),
    env: c.env.map((e) => ({ key: e.key })), // keys only — discover blanks the values
    // Only persistent data moves: named volumes + host bind-mounts. Ephemeral/special mounts
    // (tmpfs, npipe, cluster) carry no data to migrate, so they are dropped rather than mis-reported
    // as a persistent "named" volume.
    volumes: c.mounts
      .filter((m) => m.type === "volume" || m.type === "bind")
      .map(
        (m): ForeignVolume => ({
          name: m.type === "volume" ? m.source : undefined,
          hostPath: m.type === "bind" ? m.source : undefined,
          mountPath: m.target,
          type: m.type === "bind" ? "bind" : "named",
          ownerRef: c.id,
        }),
      ),
    replicas: 1,
  }));

  const warnings: string[] = [];
  if (composeManaged > 0) {
    warnings.push(
      `${composeManaged} compose-managed container(s) skipped — import those through their source PaaS adapter (Coolify/Dokploy/CapRover/Dokku), not the local-docker adapter`,
    );
  }
  return { servers: [{ ref: serverId }], apps, databases: [], services: [], volumes: [], sharedEnv: [], warnings };
}

/**
 * The `local-docker` import source: adopts foreign Docker containers on a Tugra-enrolled server, reusing the
 * existing migrator's discover (which enforces the caller's per-server authorization and blanks env values).
 */
export class LocalDockerSource implements ImportSource {
  readonly kind = "local-docker" as const;

  constructor(
    private readonly migrator: MigratorService,
    private readonly userId: string,
    private readonly serverId: string,
  ) {}

  capabilities(): ImportSourceCapabilities {
    return { apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false };
  }

  async verify(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true }; // discover() validates the agent/Docker and throws with a clear message if absent
  }

  async discover(): Promise<ForeignFleet> {
    const { containers } = await this.migrator.discover(this.userId, this.serverId);
    return containersToFleet(this.serverId, containers);
  }

  async fetchSecrets(_ref: string): Promise<FetchedSecrets> {
    return { values: {}, unresolved: [] }; // dry-run only for now; the executor path lands in S4c
  }

  async close(): Promise<void> {}
}
