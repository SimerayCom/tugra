import type { ForeignApp, ForeignDb, ForeignFleet } from "../foreign-fleet";

/**
 * A scrubbed, deterministic fleet shaped like a real self-hosted Coolify estate: 78 apps (74 Dockerfile-from-git,
 * 3 image, 1 nixpacks), 29 databases (14 redis, 10 postgres incl. one flagged large, 5 mariadb), and a few
 * multi-container services (INFO only). All names are generic placeholders — no customer or business names.
 * Same-named apps appear across the (Coolify has no tree) single namespace on purpose, to exercise duplicates.
 */
export const OWNER_SERVER_REF = "srv-1";
export const BIG_DB_REF = `database:${OWNER_SERVER_REF}:db-pg-10`;

const pad = (n: number): string => String(n).padStart(2, "0");

export function ownerFleet(): ForeignFleet {
  const apps: ForeignApp[] = [];
  for (let i = 1; i <= 78; i++) {
    const image = i > 74 && i <= 77;
    const nixpacks = i === 78;
    // three apps are all literally called "api" (different source ids) — the deliberate same-name collision
    const name = i === 3 || i === 31 || i === 62 ? "api" : `service-${pad(i)}`;
    apps.push({
      sourceRef: `app-${pad(i)}`,
      name,
      kind: image ? "image" : "git",
      buildPack: image ? "image" : nixpacks ? "nixpacks" : "dockerfile",
      ...(image ? { image: "nginx:1.27" } : { git: { url: `org/repo-${pad(i)}`, branch: "main", dockerfilePath: "/Dockerfile" } }),
      ports: [3000],
      serverRef: OWNER_SERVER_REF,
      env: [],
      volumes: [],
      domains: [],
    });
  }
  const databases: ForeignDb[] = [];
  const engines: Array<ForeignDb["engine"]> = [...Array(14).fill("REDIS"), ...Array(10).fill("POSTGRES"), ...Array(5).fill("MARIADB")];
  engines.forEach((engine, idx) => {
    const n = idx + 1;
    const pgNo = engine === "POSTGRES" ? n - 14 : 0;
    databases.push({
      sourceRef: engine === "POSTGRES" ? `db-pg-${pgNo}` : `db-${n}`,
      name: engine === "POSTGRES" && pgNo === 10 ? "ticks" : `${engine.toLowerCase()}-${pad(n)}`,
      engine,
      version: engine === "POSTGRES" ? "16" : engine === "REDIS" ? "7" : "11",
      serverRef: OWNER_SERVER_REF,
    });
  });
  return {
    servers: [{ ref: OWNER_SERVER_REF, name: "box", ip: "10.0.0.1" }],
    apps,
    databases,
    services: [
      { sourceRef: "svc-1", name: "observability", memberApps: [], memberDbs: [], serverRef: OWNER_SERVER_REF },
      { sourceRef: "svc-2", name: "object-store", memberApps: [], memberDbs: [], serverRef: OWNER_SERVER_REF },
    ],
    volumes: [],
    sharedEnv: [],
    warnings: [],
  };
}
