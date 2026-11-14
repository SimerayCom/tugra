/**
 * The exit-code contract of the main deploy command, as ONE pure function shared by the live deploy path and
 * the hub-restart adoption path — so a recovered deploy is judged by exactly the rules the live one would have
 * applied, against the plan that was frozen when the command was dispatched (not the app's config of today).
 *
 *   0 → healthy & live (SUCCESS)
 *   3 → the new version failed its PRE-cutover health gate and the PREVIOUS one is still serving — but only the
 *       rolling/recreate scripts emit 3 with that meaning, and only when a previous live version actually existed
 *       (hadPrev); otherwise a plain hard-cutover build that happens to exit 3 is a hard failure.
 *   4 → rolling only: POST-cutover soak failed and the script already restarted the previous container → the old
 *       version is provably live again (auto-rollback).
 *   anything else → hard failure.
 */
export interface DeployOutcomePlan {
  rolling: boolean;
  recreate: boolean;
  isCompose: boolean;
  /** A previous SUCCESS image existed to fall back to (recreate: the prev row at dispatch; rolling: any kept image). */
  hadPrev: boolean;
}

export interface DeployOutcome {
  ok: boolean;
  rolledBack: boolean;
}

export function decideDeployOutcome(exitCode: number, plan: DeployOutcomePlan): DeployOutcome {
  const ok = exitCode === 0;
  let rolledBack = false;
  if (exitCode === 3 && !plan.isCompose && (plan.recreate || plan.rolling)) rolledBack = plan.hadPrev;
  if (exitCode === 4 && plan.rolling && !plan.isCompose) rolledBack = true;
  return { ok, rolledBack };
}

/**
 * Everything the adoption finalizer needs to settle a deploy the way executeDeploy would have, frozen at dispatch
 * (stored as Deployment.dispatchPlan). Pure data — no secrets (tags/refs only).
 */
export interface DispatchPlan extends DeployOutcomePlan {
  v: 1;
  isGitCompose: boolean;
  /** GIT or git-compose: the deployed-commit marker in the output is trusted. */
  gitSourced: boolean;
  /** runTag(app, dep.id) for a non-compose deploy (the image tag recorded on SUCCESS); null for compose. */
  runTag: string | null;
  registryRef: string | null;
  /** The app was RUNNING before this deploy (the live path's wasRunning). */
  wasRunning: boolean;
  /** A post-deploy hook was configured at dispatch (classic path): adoption runs it after a SUCCESS, as the live
   *  path would have. */
  postDeploy: boolean;
  /** Head of the build-server phase output (GIT app with a separate build server): carries the commit marker and
   *  the build log so an adopted deploy records them like the live path. null when no build-server phase ran. */
  buildLogHead: string | null;
}

export function isDispatchPlan(v: unknown): v is DispatchPlan {
  const p = v as Partial<DispatchPlan> | null;
  return !!p && typeof p === "object" && p.v === 1 && typeof p.rolling === "boolean" && typeof p.recreate === "boolean" && typeof p.isCompose === "boolean" && typeof p.hadPrev === "boolean";
}
