import type { CreateAppInput } from "../applications/dto";
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
    input.dockerfilePath = opt(app.git?.dockerfilePath);
    input.buildCommand = opt(app.buildCommand);
    input.outputDir = opt(app.publishDirectory);
    if (opts.gitSourceId) input.gitSourceId = opts.gitSourceId; // link a private GitHub-App repo to a connected GitSource
  }
  return input;
}
