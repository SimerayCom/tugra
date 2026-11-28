/**
 * One swap at a time inside a campaign: an in-place run may not be approved to switch production traffic while another run of the same
 * campaign is switching (or approved to, or stuck half way). Pure; the run service asks it at the VERIFY approval.
 */
export interface SwapTurnRun {
  status: string;
  inPlace: boolean;
  steps: ReadonlyArray<{ key: string; status: string; approved?: boolean }>;
}

const stepStatus = (r: SwapTurnRun, key: string): string | undefined => r.steps.find((s) => s.key === key)?.status;

/**
 * Whether this in-place run is switching production traffic or is approved to: its VERIFY approval is recorded (or passed) and CUTOVER is not
 * done. Used to keep the swaps of one campaign one at a time.
 */
export function swapInFlight(r: SwapTurnRun): boolean {
  if (!r.inPlace) return false;
  if (["ABORTED", "ROLLED_BACK", "REVERSED", "COMPLETED", "DRY_RUN_DONE"].includes(r.status)) return false;
  const cutover = stepStatus(r, "CUTOVER");
  if (cutover === "PASSED" || cutover === "SKIPPED" || cutover === "COMPENSATED") return false;
  if (cutover !== undefined && cutover !== "PENDING") return true;
  const verify = r.steps.find((s) => s.key === "VERIFY");
  return verify?.status === "PASSED" || verify?.approved === true;
}
