import type { CreateAppInput } from "../applications/dto";
import { SetVolumesSchema } from "../applications/dto";
import type { AppVolume } from "../deploy/deploy-script";
import type { ForeignApp } from "./foreign-fleet";
import { mapBuildPack } from "./buildpack-map";

/** Options for turning a discovered foreign app into a Tugra app to create. */
export interface AppCreateOptions {
  serverId: string; // the target Tugra server/cluster the app is created on
  environmentId?: string;
  sourceTag?: string; // e.g. "coolify" — added alongside "imported" for traceability
  gitSourceId?: string; // a connected GitHub App (GitSource) to link a private-repo import to; create() re-checks the team
}

/**
 * Pure: map a resolved {@link ForeignApp} (+ its already-fetched env values) to the exact
 * {@link CreateAppInput} the ApplicationsService expects. Source-agnostic — every source adapter's apps go
 * through this, so the executor stays one path. `deploy:false`: an import creates the record, then deploys as
 * a separate, observable step. A real domain maps to exposeMode "custom"; no domain → "none" (never mint a
 * magic domain on import — the operator cuts over DNS explicitly later).
 */
/** Coolify (and others) can store empty strings for optional fields, but CreateAppSchema requires min(1) —
 *  coerce "" to undefined so an otherwise-valid app isn't rejected. */
const opt = (v: string | undefined): string | undefined => (v ? v : undefined);

/** Coolify stores in-repo paths absolute (`/apps/api`, `/Dockerfile`, `/` for the repo root), but Tugra's
 *  REPO_PATH/BASE_DIR are repo-RELATIVE (no leading `/`). The importer calls service.create() directly, so it
 *  skips the DTO that would otherwise reject these — normalize here: strip leading slashes, collapse the
 *  root (`/`, "", `.`) to undefined, and drop a trailing slash. Returns undefined for a value that isn't a
 *  usable relative path. */
const relPath = (v: string | undefined): string | undefined => {
  if (!v) return undefined;
  const s = v.replace(/^\/+/, "").replace(/\/+$/, "");
  return s && s !== "." ? s : undefined;
};

export function foreignAppToCreateInput(app: ForeignApp, env: Record<string, string>, opts: AppCreateOptions): CreateAppInput {
  const build = mapBuildPack(app); // { source: IMAGE|GIT|COMPOSE, buildType? }
  const domain = (app.domains ?? []).find((d) => d.primary) ?? (app.domains ?? [])[0];

  const input: CreateAppInput = {
    name: app.name,
    serverId: opts.serverId,
    environmentId: opts.environmentId,
    source: build.source,
    env,
    deploy: false,
    tags: ["imported", ...(opts.sourceTag ? [opts.sourceTag] : [])],
    containerPort: app.ports?.[0],
    domain: domain?.host,
    https: domain?.https,
    exposeMode: domain ? "custom" : "none",
  };

  if (build.source === "IMAGE") {
    input.image = opt(app.image);
  } else if (build.source === "COMPOSE") {
    input.composeFile = opt(app.composeFile); // may be absent without a read:sensitive token → create validates
  } else {
    input.gitUrl = opt(app.git?.url);
    input.gitBranch = opt(app.git?.branch);
    input.buildType = build.buildType;
    // In-repo paths are normalized to Tugra's relative form (Coolify stores them absolute). baseDirectory was
    // previously dropped entirely → an imported monorepo app built from the repo root; wire it through now.
    input.dockerfilePath = relPath(app.git?.dockerfilePath);
    input.baseDirectory = relPath(app.git?.baseDirectory);
    input.buildCommand = opt(app.buildCommand);
    input.outputDir = relPath(app.publishDirectory);
    if (opts.gitSourceId) input.gitSourceId = opts.gitSourceId; // link a private GitHub-App repo to a connected GitSource
  }
  return input;
}

/** Why a declared mount was NOT turned into a Tugra volume. */
export type VolumeSkipReason = "file-mount" | "no-mount-path" | "invalid-path" | "duplicate-path" | "over-limit" | "compose-managed";
export interface VolumeSkip {
  mountPath: string;
  reason: VolumeSkipReason;
}
export interface MappedVolumes {
  volumes: AppVolume[];
  skipped: VolumeSkip[];
}

const MAX_APP_VOLUMES = 20; // mirrors SetVolumesSchema.max(20)
const VOLUME_PATH_RE = /^\/[A-Za-z0-9._/-]+$/; // mirrors SetVolumesSchema path rule
const VOLUME_NAME_MAX = 41; // mirrors SetVolumesSchema name rule /^[a-z0-9][a-z0-9_-]{0,40}$/

/** Canonicalize a container mount path: trim, collapse repeated slashes, strip a trailing slash. */
const canonMountPath = (raw: string | undefined): string =>
  (raw ?? "").trim().replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");

/** Deterministic, schema-valid volume name derived from a container path (collisions resolved by the caller). */
const slugForPath = (path: string): string => {
  const s = path
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, VOLUME_NAME_MAX);
  return s || "data";
};

/**
 * Pure: map a discovered foreign app's declared mounts to the EMPTY per-app named volumes Tugra will declare on
 * the created app (docker name `tugra_appv_<appId>_<slug>`), plus a report of mounts we deliberately did NOT
 * declare. This slice declares the MOUNTS only — it never copies their DATA (that is a later slice).
 *
 * Both named volumes AND host bind-mounts become EMPTY named volumes at the same container path: a source
 * bind `hostPath` is a path on the SOURCE host, so re-mounting it on the target would let an untrusted source
 * pick an arbitrary writable target path (the local-docker migrator refuses binds for the same reason).
 * `ForeignVolume.name`/`hostPath` are therefore IGNORED; the destination name is derived deterministically
 * from the container mountPath so a later data slice can recompute it from (app, mountPath).
 *
 * The importer calls ApplicationsService.setVolumes directly, bypassing the controller's SetVolumesSchema, and
 * the deploy script interpolates `-v tugra_appv_<id>_<name>:<path>` UNQUOTED into `sh -c`. So this mapper
 * enforces the schema's rules itself (lowercase name, absolute restricted path, ≤20, unique) and re-parses its
 * own output with SetVolumesSchema as a final guard.
 */
export function foreignAppToVolumes(app: ForeignApp): MappedVolumes {
  const declared = app.volumes ?? [];

  // A compose app's volumes live in its compose file; the docker-run volume args are never emitted for it, so
  // declaring them would be dead data.
  if (mapBuildPack(app).source === "COMPOSE") {
    return { volumes: [], skipped: declared.map((v) => ({ mountPath: v.mountPath ?? "", reason: "compose-managed" as const })) };
  }

  const skipped: VolumeSkip[] = [];
  const seen = new Set<string>();
  const valid: string[] = []; // canonical container paths, first-seen order
  for (const v of declared) {
    if (v.type === "file") {
      skipped.push({ mountPath: v.mountPath ?? "", reason: "file-mount" });
      continue;
    }
    const path = canonMountPath(v.mountPath);
    if (!path || path === "/") {
      skipped.push({ mountPath: v.mountPath ?? "", reason: "no-mount-path" });
      continue;
    }
    const bad = path.length > 512 || !VOLUME_PATH_RE.test(path) || path.split("/").some((seg) => seg === "." || seg === "..");
    if (bad) {
      skipped.push({ mountPath: path, reason: "invalid-path" });
      continue;
    }
    if (seen.has(path)) {
      skipped.push({ mountPath: path, reason: "duplicate-path" });
      continue;
    }
    seen.add(path);
    valid.push(path);
  }

  // Deterministic + discovery-order-independent: sort by path, then cap at the schema limit.
  valid.sort();
  const survivors = valid.slice(0, MAX_APP_VOLUMES);
  for (const path of valid.slice(MAX_APP_VOLUMES)) skipped.push({ mountPath: path, reason: "over-limit" });

  const usedNames = new Set<string>();
  const volumes: AppVolume[] = [];
  for (const path of survivors) {
    const base = slugForPath(path);
    let name = base;
    for (let n = 2; usedNames.has(name); n++) {
      const suffix = `-${n}`;
      name = base.slice(0, VOLUME_NAME_MAX - suffix.length) + suffix;
    }
    usedNames.add(name);
    volumes.push({ name, path });
  }

  // Belt-and-braces: the output must satisfy the same schema the controller would have enforced. Unreachable in
  // practice — but if it ever fails, declare nothing rather than feed an unchecked value to the deploy shell.
  if (!SetVolumesSchema.safeParse({ volumes }).success) {
    return { volumes: [], skipped: declared.map((v) => ({ mountPath: v.mountPath ?? "", reason: "invalid-path" as const })) };
  }
  return { volumes, skipped };
}
