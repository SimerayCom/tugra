/**
 * Image digests from the host inventory (R11), pure. An image app that runs a FLOATING tag (`latest`, no tag) on the source is
 * pinned to the digest the source host reports for the container that runs it, so the copy deploys what the source runs and not
 * what the registry serves today (a Meilisearch data directory or a gotenberg build may not open under a newer `latest`).
 *
 * Only what the host reported for THAT app's own running container counts: the container must be the app's (the name rule of the
 * source scripts), running, and carry a digest whose repository is the image's repository. When the host reports no such digest
 * (a locally built image has none) or two different ones, nothing is pinned for the app: it stays unpinned and the pin-hint
 * check of the run says so. An operator's own pin (`operator-attested`) is never replaced; a digest an earlier inventory reported
 * is replaced by a newer one.
 */
import type { RunHint } from "../../import/baseline/run-hints";
import { DIGEST_RE, imageRepoOf, isFloatingImage } from "../../import/baseline/image-pins";
import { coolifyRefOf } from "../../../../importer/sources/coolify-control";
import { containerNameMatches } from "../source-control/source-scripts";
import type { HostInventory } from "./host-protocol";

/** One image app of the plan: its itemRef (`app:<host>:<uuid>`) and the image the plan shows for it. */
export interface PinCandidate {
  itemRef: string;
  image: string;
  /** The app's custom container name prefix, when it has one (its container is `<prefix>-<timestamp>`). */
  containerPrefix?: string;
}

/** The repository of an image as docker prints it in RepoDigests: the Docker Hub aliases are folded (`docker.io/library/nginx` is `nginx`). */
export function normalizedRepo(ref: string): string {
  let r = imageRepoOf(ref).toLowerCase();
  for (const pre of ["index.docker.io/", "registry-1.docker.io/", "docker.io/"]) if (r.startsWith(pre)) r = r.slice(pre.length);
  return r.startsWith("library/") ? r.slice("library/".length) : r;
}

/** The pin hints the inventories justify for the floating image apps of the plan. Deterministic order (image, scope). */
export function derivePins(candidates: readonly PinCandidate[], inventories: ReadonlyMap<string, HostInventory>): RunHint[] {
  const found = new Map<string, RunHint | null>(); // null = two different digests were reported: ambiguous, never pinned
  for (const cand of candidates) {
    if (!isFloatingImage(cand.image)) continue;
    const ref = coolifyRefOf(cand.itemRef);
    const host = cand.itemRef.split(":")[1] ?? "_";
    const inv = inventories.get(host);
    if (!ref || ref.kind !== "application" || !inv?.complete) continue;
    const repo = normalizedRepo(cand.image);
    const digests = new Set<string>();
    for (const c of inv.containers) {
      if (c.state !== "running" || !containerNameMatches(c.name, ref.uuid, "application", cand.containerPrefix ? [cand.containerPrefix] : [])) continue;
      for (const d of c.repoDigests ?? []) {
        const at = d.indexOf("@");
        if (at > 0 && normalizedRepo(d.slice(0, at)) === repo && DIGEST_RE.test(d.slice(at + 1))) digests.add(d.slice(at + 1));
      }
    }
    if (digests.size === 0) continue;
    const scope = host === "_" ? "" : host;
    const id = `${cand.image}\u0000${scope}`;
    const prev = found.get(id);
    if (digests.size > 1 || (prev && prev.value !== [...digests][0]) || prev === null) found.set(id, null);
    else found.set(id, { kind: "image-pin", key: cand.image, scope, value: [...digests][0], evidence: "host-loop-reported" });
  }
  return [...found.values()].filter((h): h is RunHint => h !== null).sort((a, b) => (a.key + a.scope < b.key + b.scope ? -1 : 1));
}

/**
 * Of the derived pins, those that may be written: never next to an operator-attested pin of the same image that already answers for the
 * derived scope, i.e. one at that very scope or one for every server (scope ""). `pinFor` prefers a host-scoped pin over an every-server
 * one, so a derived host pin written beside the operator's every-server pin would silently win over it.
 */
export function pinsToWrite(derived: readonly RunHint[], existing: readonly RunHint[]): RunHint[] {
  const operator = new Set(existing.filter((h) => h.kind === "image-pin" && h.evidence === "operator-attested").map((h) => `${h.key}\u0000${h.scope}`));
  return derived.filter((h) => !operator.has(`${h.key}\u0000${h.scope}`) && !operator.has(`${h.key}\u0000`));
}
