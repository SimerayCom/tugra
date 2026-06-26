/** Current step of the new-resource wizard: 1 Type → 2 Server → 3 Configure. */
export function wizardStep(hasSel: boolean, hasServer: boolean): 1 | 2 | 3 {
  if (!hasSel) return 1;
  if (!hasServer) return 2;
  return 3;
}
