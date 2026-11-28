/**
 * Exact images of a run (pure): what the source RUNS for every app, database and stack member, recorded as run hints and written into
 * the apply input, so a redeploy or a move to another server never pulls a newer image than the one the source runs. Moving to Tugra
 * changes the version of nothing; only the team decides to upgrade, by editing the image afterwards.
 *
 * Two hint kinds (both secret-free):
 *  - `exact-image`: key = the plan itemRef of an app or database, or `<service itemRef>#<member>` for a stack member (`servicePinKey`),
 *    scope = "", value = the pin (`repo:tag@sha256:...`, or `repo:<version>`), then a space and the image's own version label when it
 *    has one (see `encodeExact`). Written from the host inventory, the digests the source's running containers report.
 *  - `exact-off`: key = the plan itemRef, value = `off`: the owner unticked "keep the exact image" for that item. It stays until the owner
 *    ticks it again; the recorded pin stays too, so the box can be ticked back without a new inventory.
 *
 * The pins are part of the APPLY INPUT (`imagePins` for apps and databases, `serviceChoices[].pins` for members), never of the plan hash:
 * a plan with no pins hashes exactly as before, and the stale-plan guard compares the same plan it always did.
 */
import { EXACT_IMAGE_KIND, EXACT_OFF_KIND, decodeExactHint, isExactPinFor } from "../../../../importer/exact-image";
import type { ServiceChoice } from "../../../../importer/dto";
import type { ExactRestoreTarget } from "../../../../importer/exact-record";
import type { RunHint } from "./run-hints";

export { EXACT_IMAGE_KIND, EXACT_OFF_KIND };

/** The importer takes at most this many stack choices in one apply (its own limit). */
const MAX_SERVICE_CHOICES = 64;

/** The hint key of a stack member's pin: `<itemRef>#<member>` (the same key the operator's `service-pin` hints use). */
export const memberKey = (itemRef: string, member: string): string => `${itemRef}#${member}`;

/** The itemRef an exact-image hint key names (`<itemRef>` or `<itemRef>#<member>`). */
export const itemRefOfKey = (key: string): string => {
  const at = key.lastIndexOf("#");
  return at > 0 && key.startsWith("service:") ? key.slice(0, at) : key;
};

/** Has the owner unticked "keep the exact image" for this item? */
export const isExactOff = (hints: readonly RunHint[], itemRef: string): boolean => hints.some((h) => h.kind === EXACT_OFF_KIND && h.key === itemRef && h.value === "off");

/** The recorded pin of an app / database (`member` empty) or a stack member, unless the owner opted the item out. */
export function exactPinOf(hints: readonly RunHint[], itemRef: string, member = ""): ReturnType<typeof decodeExactHint> {
  if (isExactOff(hints, itemRef)) return null;
  const key = member ? memberKey(itemRef, member) : itemRef;
  const h = hints.find((x) => x.kind === EXACT_IMAGE_KIND && x.key === key);
  return h ? decodeExactHint(h.value) : null;
}

export interface ExactRow {
  itemRef: string;
  /** The compose service key; "" for an app or a database. */
  member: string;
  ref: string;
  tag: string;
  version: string | null;
  digest: string | null;
  /** The owner keeps the exact image (the default): false when the item is unticked. */
  kept: boolean;
}

/** Every recorded exact image of the run, with whether the owner keeps it. Stable order (itemRef, member). */
export function exactRows(hints: readonly RunHint[]): ExactRow[] {
  const out: ExactRow[] = [];
  for (const h of hints) {
    if (h.kind !== EXACT_IMAGE_KIND) continue;
    const d = decodeExactHint(h.value);
    if (!d) continue;
    const itemRef = itemRefOfKey(h.key);
    const member = h.key.length > itemRef.length ? h.key.slice(itemRef.length + 1) : "";
    out.push({ itemRef, member, ref: d.ref, tag: d.tag, version: d.version, digest: d.digest, kept: !isExactOff(hints, itemRef) });
  }
  return out.sort((a, b) => (a.itemRef + "\u0000" + a.member < b.itemRef + "\u0000" + b.member ? -1 : 1));
}

interface ApplyWithPins {
  serviceChoices?: Record<string, ServiceChoice>;
  imagePins?: Record<string, string>;
}

/**
 * The apply input with the run's exact images written in: a stack member's pin into `serviceChoices[itemRef].pins` and an app's or a
 * database's into `imagePins`. Never overrides what the caller wrote (an owner's own pin, a stack that disables pinning, a skipped
 * stack), skips an item the owner opted out, and leaves the input untouched when there is nothing to write.
 */
export function withExactPins<T extends ApplyWithPins>(input: T, hints: readonly RunHint[]): T {
  const rows = exactRows(hints).filter((r) => r.kept);
  if (!rows.length) return input;
  const choices: Record<string, ServiceChoice> = { ...(input.serviceChoices ?? {}) };
  const imagePins: Record<string, string> = { ...(input.imagePins ?? {}) };
  let touched = false;
  for (const r of rows) {
    const kind = r.itemRef.slice(0, r.itemRef.indexOf(":"));
    if (r.member) {
      if (kind !== "service") continue;
      const cur = choices[r.itemRef];
      if (cur?.skip || cur?.pinImages === false || cur?.pins?.[r.member]) continue;
      if (!cur && Object.keys(choices).length >= MAX_SERVICE_CHOICES) continue;
      choices[r.itemRef] = { ...(cur ?? {}), pins: { ...(cur?.pins ?? {}), [r.member]: r.ref } };
      touched = true;
    } else if (kind === "app" || kind === "database") {
      if (imagePins[r.itemRef]) continue;
      imagePins[r.itemRef] = r.ref;
      touched = true;
    }
  }
  if (!touched) return input;
  return { ...input, ...(Object.keys(choices).length ? { serviceChoices: choices } : {}), ...(Object.keys(imagePins).length ? { imagePins } : {}) };
}

/** May a recorded pin replace the image the plan shows for an app or a stack member? (Same repository, nothing already on a digest.) */
export const pinReplaces = (planImage: string | null | undefined, pin: string): boolean => (planImage ? isExactPinFor(planImage, pin) : false);

/** What the op's meta says of the image the source WRITES for each item: an app's or database's own, and each stack member's. */
export interface SourceImages {
  plan?: { items?: Array<{ itemRef?: unknown; proposed?: { image?: unknown } }> };
  stackImages?: Array<{ itemRef?: unknown; images?: Array<{ member?: unknown; image?: unknown }> }>;
}

/**
 * The records to put back on the image the source writes, for the items the owner just unticked: each item's recorded pin (`from`, what the
 * run wrote) and the source's own ref (`to`), with the Tugra record of the item (a DONE task). An item with no recorded pin, no source
 * image or no record has nothing to restore.
 */
export function restoreTargets(itemRefs: readonly string[], hints: readonly RunHint[], meta: SourceImages, tasks: ReadonlyArray<{ itemRef: string | null; kind: string; resourceId: string | null }>): ExactRestoreTarget[] {
  const out: ExactRestoreTarget[] = [];
  const rows = exactRows(hints);
  for (const itemRef of new Set(itemRefs)) {
    const t = tasks.find((x) => x.itemRef === itemRef && x.resourceId);
    if (!t?.resourceId) continue;
    const own = rows.filter((r) => r.itemRef === itemRef);
    if (itemRef.startsWith("service:")) {
      const src = new Map((meta.stackImages ?? []).filter((s) => s.itemRef === itemRef).flatMap((s) => s.images ?? []).flatMap((m) => (typeof m.member === "string" && typeof m.image === "string" ? [[m.member, m.image] as const] : [])));
      const members = Object.fromEntries(own.filter((r) => r.member && src.has(r.member)).map((r) => [r.member, { from: r.ref, to: src.get(r.member)! }]));
      if (Object.keys(members).length) out.push({ kind: "service", id: t.resourceId, members });
    } else {
      const r = own.find((x) => x.member === "");
      const image = (meta.plan?.items ?? []).find((i) => i.itemRef === itemRef)?.proposed?.image;
      if (r && typeof image === "string" && image) out.push({ kind: itemRef.startsWith("database:") ? "database" : "app", id: t.resourceId, from: r.ref, to: image });
    }
  }
  return out;
}
