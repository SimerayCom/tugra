/**
 * Pure state machine for the /welcome first-run wizard. All step logic lives here (not in page.tsx,
 * per the Next App Router named-export rule) so it can be unit-tested in isolation.
 *
 * The wizard walks: welcome → create-admin → instance-basics → add-first-server → first-workload → done.
 * `resolveStep` CLAMPS a requested `?step=` against the auth state so a visitor can never skip the
 * bootstrap (owner registration) nor land on it after it's done. The redirect DECISIONS for the three
 * "not in the wizard" states (loading, a returning logged-out user, a non-owner) live in the component,
 * not here — this function only resolves steps for an ACTIVE wizard.
 *
 * Correctness note: the AuthProvider sets `initialized = true` the moment `api.me()` succeeds, so
 * `loggedIn === true` implies `initialized === true` always. The clamp therefore keys only on `loggedIn`.
 */

export const STEPS = ["welcome", "create-admin", "instance-basics", "add-first-server", "first-workload", "done"] as const;
export type Step = (typeof STEPS)[number];

/** Steps that require being logged in as the owner (everything after bootstrap). */
const POST_BOOTSTRAP: readonly Step[] = ["instance-basics", "add-first-server", "first-workload", "done"];

/** Non-bootstrap steps the owner may skip straight to the end. welcome/create-admin are NOT skippable. */
const SKIPPABLE: readonly Step[] = ["instance-basics", "add-first-server", "first-workload"];

function isStep(v: string | null): v is Step {
  return v !== null && (STEPS as readonly string[]).includes(v);
}

/**
 * Resolve the effective wizard step from the URL `?step=` and the auth state, clamping illegal jumps.
 * - Not logged in: only welcome/create-admin are reachable; any post-bootstrap request clamps BACK to
 *   create-admin (you must register the owner first). Unknown → welcome.
 * - Logged in (⟹ bootstrap done): welcome/create-admin clamp FORWARD to instance-basics (re-registering
 *   is closed/would 409). Post-bootstrap steps pass through. Unknown/absent → instance-basics (resume point).
 */
export function resolveStep(requested: string | null, ctx: { loggedIn: boolean }): Step {
  const step = isStep(requested) ? requested : null;
  if (!ctx.loggedIn) {
    if (step === "create-admin") return "create-admin";
    if (step && POST_BOOTSTRAP.includes(step)) return "create-admin"; // can't skip bootstrap
    return "welcome";
  }
  // logged in → bootstrap already complete
  if (step === null || step === "welcome" || step === "create-admin") return "instance-basics";
  return step; // a valid post-bootstrap step
}

/** The next step in the linear flow; `done` is terminal (returns itself). */
export function nextStep(step: Step): Step {
  const i = STEPS.indexOf(step);
  return i < 0 || i >= STEPS.length - 1 ? "done" : STEPS[i + 1];
}

/** Whether this step offers a "skip" that jumps to the end. */
export function isSkippable(step: Step): boolean {
  return SKIPPABLE.includes(step);
}

/**
 * 1-based position for a compact "Step N of M" indicator. `welcome` (a pre-flight intro) and `done`
 * (the terminal screen) are not counted as progress steps; the four real steps are create-admin(1) …
 * first-workload(4). Returns 0 for welcome/done.
 */
const NUMBERED: readonly Step[] = ["create-admin", "instance-basics", "add-first-server", "first-workload"];
export const TOTAL_STEPS = NUMBERED.length;

export function stepNumber(step: Step): number {
  const i = NUMBERED.indexOf(step);
  return i < 0 ? 0 : i + 1;
}
