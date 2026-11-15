/** Shared test fixtures for the volume-stream specs (not imported by production code). */
import type { VxVolumeTarget } from "../vx-targets";

export const OP = "ckop000000000000000000001";
export const APP_ID = "ckapp00000000000000000001";
export const DB_ID = "ckdb000000000000000000001";
export const SERVER_ID = "cksrv00000000000000000001";
export const TEAM_ID = "ckteam0000000000000000001";
export const APP_REF = "app:srv1:5f3a9c";
export const DB_REF = "database:srv1:pg7c1";
export const APP_VOL_REF = "volume:srv1:5f3a9c:data";
export const DB_VOL_REF = "volume:srv1:pg7c1:data";
export const RUN = "run_abcdef012345";
export const GiB = 1024 ** 3;

export const appTask = (over: Record<string, unknown> = {}) => ({
  id: "t-app",
  itemRef: APP_REF,
  kind: "app",
  status: "DONE",
  resourceType: "application",
  resourceId: APP_ID,
  result: { volumes: { mounts: [{ path: "/var/www/data", name: "data" }], declared: 1 } },
  steps: null,
  ...over,
});
export const dbTask = (over: Record<string, unknown> = {}) => ({
  id: "t-db",
  itemRef: DB_REF,
  kind: "database",
  status: "DONE",
  resourceType: "database",
  resourceId: DB_ID,
  result: { name: "pg", databaseId: DB_ID, credentialsCarried: true, imageCarried: true },
  steps: null,
  ...over,
});

export function opRow(over: Record<string, unknown> = {}) {
  return {
    id: OP,
    kind: "import",
    actorId: "user-1",
    meta: { sourceKind: "coolify", serverId: SERVER_ID, plan: { items: [{ itemRef: DB_REF, kind: "database", proposed: { dataMode: "volume" } }] } },
    cancelRequestedAt: null,
    migrationTokenHash: "h",
    migrationTokenExpiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    tasks: [appTask(), dbTask()],
    ...over,
  };
}

export const target = (over: Partial<VxVolumeTarget> = {}): VxVolumeTarget => ({ itemRef: APP_VOL_REF, destType: "app-volume", name: "data", mountPath: "/var/www/data", appItemRef: APP_REF, ...over });

export const sha = (c: string): string => c.repeat(64).slice(0, 64);

/** A well-formed probe output for one volume (staging + docker root free KiB; devices equal or different). */
export function probeOutput(volume: string, o: { stageKb?: number | null; dockerKb?: number | null; sameDev?: boolean } = {}): string {
  const stage = o.stageKb === null ? "-" : String(o.stageKb ?? 500 * 1024 * 1024);
  const dock = o.dockerKb === null ? "-" : String(o.dockerKb ?? 500 * 1024 * 1024);
  return [
    `TUGRA_DF /var/lib/docker ${dock} 10`,
    `TUGRA_DF /etc/tugra/app-moves ${stage} ${o.sameDev ? 10 : 20}`,
    "TUGRA_TOOL curl 1",
    "TUGRA_TOOL split 1",
    "TUGRA_TOOL sha256sum 1",
    "TUGRA_TOOL gzip 1",
    "TUGRA_TOOL helper 1",
    `TUGRA_VOL ${volume} ABSENT`,
    "TUGRA_PROBE_END",
  ].join("\n");
}
