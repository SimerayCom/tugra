/**
 * Write the exact image the source runs into a record Tugra created: an IMAGE app's image, a never-started database's image, or the member
 * images of a compose stack's stored compose. Shared by the guided run (DEPLOY_DARK) and the in-place takeover, so both keep the image the
 * source runs and neither changes it later: a redeploy from Tugra uses the stored ref, and a move to another server pulls by its digest.
 *
 * Every write is guarded: the ref must be a pin of the record's OWN repository (never another image), a record already on a digest is left
 * alone, a database that was started is never changed (its version is edited through its own path), and the same image again changes nothing.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { PrismaService } from "../prisma/prisma.service";
import type { ApplicationsService } from "../applications/applications.service";
import type { DatabasesService } from "../databases/databases.service";
import { isDigestPinned, isExactPinFor } from "./exact-image";

export interface ExactRecordDeps {
  prisma: Pick<PrismaService, "application" | "database">;
  apps: Pick<ApplicationsService, "setSource" | "setComposeFile">;
  databases: Pick<DatabasesService, "setImage">;
}

export type ExactTarget = { kind: "app" | "database"; id: string; ref: string } | { kind: "service"; id: string; members: Record<string, string> };

/** What a write came to: the record now runs the image (`pinned` = changed, `same` = it already did or is the owner's own digest), or it cannot (`refused`). */
export type ExactState = "pinned" | "same" | "refused";

/**
 * The stored compose with the exact image of each member written in (`services.<member>.image`). Only a member of that repository that is
 * not on a digest yet changes, so a pin never swaps what a member runs. `compose` is null when nothing changed or the compose does not
 * parse; `refused` lists the members whose compose image the pin cannot replace (another repository), which would run something else.
 */
export function pinComposeMembersDetailed(composeFile: string, members: Record<string, string>): { compose: string | null; refused: string[] } {
  let doc: unknown;
  try {
    doc = parseYaml(composeFile, { merge: true, maxAliasCount: 50 });
  } catch {
    return { compose: null, refused: Object.keys(members) };
  }
  const services = (doc as { services?: Record<string, { image?: unknown }> } | null)?.services;
  if (!services || typeof services !== "object") return { compose: null, refused: Object.keys(members) };
  let changed = false;
  const refused: string[] = [];
  for (const [member, ref] of Object.entries(members)) {
    const def = services[member];
    if (!def || typeof def.image !== "string") continue; // a member the stack does not keep runs nothing
    if (def.image === ref || isDigestPinned(def.image)) continue; // already the image, or the owner's own digest
    if (isExactPinFor(def.image, ref)) {
      def.image = ref;
      changed = true;
    } else refused.push(member);
  }
  return { compose: changed ? stringifyYaml(doc, { lineWidth: 0 }) : null, refused };
}

/** {@link pinComposeMembersDetailed} without the refused list: the new compose, or `null` when nothing changed. */
export function pinComposeMembers(composeFile: string, members: Record<string, string>): string | null {
  return pinComposeMembersDetailed(composeFile, members).compose;
}

export async function writeExactImage(deps: ExactRecordDeps, userId: string, target: ExactTarget): Promise<{ pinned: boolean; state: ExactState }> {
  const out = (state: ExactState): { pinned: boolean; state: ExactState } => ({ pinned: state === "pinned", state });
  if (target.kind === "service") {
    const c = await deps.prisma.application.findUnique({ where: { id: target.id }, select: { source: true, composeFile: true } });
    if (!c || c.source !== "COMPOSE" || !c.composeFile) return out("refused");
    const { compose, refused } = pinComposeMembersDetailed(c.composeFile, target.members);
    if (compose) await deps.apps.setComposeFile(userId, target.id, compose);
    // some members may have been written while another is refused: `pinned` says a record changed, `state` says whether it now runs the source's images
    return { pinned: !!compose, state: refused.length ? "refused" : compose ? "pinned" : "same" };
  }
  if (target.kind === "database") {
    const d = await deps.prisma.database.findUnique({ where: { id: target.id }, select: { image: true, status: true } });
    if (!d) return out("refused");
    if (d.image === target.ref) return out("same");
    if (d.status !== "NEW" || !isExactPinFor(d.image, target.ref)) return out(isDigestPinned(d.image) ? "same" : "refused");
    return out((await deps.databases.setImage(userId, target.id, target.ref)).changed ? "pinned" : "same");
  }
  const a = await deps.prisma.application.findUnique({ where: { id: target.id }, select: { source: true, image: true } });
  if (!a) return out("refused");
  if (a.source !== "IMAGE" || !a.image || a.image === target.ref || isDigestPinned(a.image)) return out("same"); // nothing to pin, already it, or the owner's own digest
  if (!isExactPinFor(a.image, target.ref)) return out("refused");
  await deps.apps.setSource(userId, target.id, { image: target.ref });
  return out("pinned");
}

export type ExactRestoreTarget = { kind: "app" | "database"; id: string; from: string; to: string } | { kind: "service"; id: string; members: Record<string, { from: string; to: string }> };

/**
 * The owner unticked "keep the exact image" after the run already wrote it: put the image the source WRITES (its tag) back. Only a record
 * that still holds exactly the pin this run wrote (`from`) changes, so an operator's own digest or a later edit is never overwritten; a
 * database that was started cannot change (its version is edited through its own path) and is reported as not restored.
 */
export async function restoreSourceImage(deps: ExactRecordDeps, userId: string, t: ExactRestoreTarget): Promise<{ restored: boolean }> {
  if (t.kind === "service") {
    const c = await deps.prisma.application.findUnique({ where: { id: t.id }, select: { source: true, composeFile: true } });
    if (!c || c.source !== "COMPOSE" || !c.composeFile) return { restored: false };
    let doc: unknown;
    try {
      doc = parseYaml(c.composeFile, { merge: true, maxAliasCount: 50 });
    } catch {
      return { restored: false };
    }
    const services = (doc as { services?: Record<string, { image?: unknown }> } | null)?.services;
    if (!services || typeof services !== "object") return { restored: false };
    let changed = false;
    for (const [member, m] of Object.entries(t.members)) {
      const def = services[member];
      if (def && def.image === m.from) {
        def.image = m.to;
        changed = true;
      }
    }
    if (!changed) return { restored: false };
    await deps.apps.setComposeFile(userId, t.id, stringifyYaml(doc, { lineWidth: 0 }));
    return { restored: true };
  }
  if (t.kind === "database") {
    const d = await deps.prisma.database.findUnique({ where: { id: t.id }, select: { image: true, status: true } });
    if (!d || d.image !== t.from || d.status !== "NEW") return { restored: false };
    return { restored: (await deps.databases.setImage(userId, t.id, t.to)).changed };
  }
  const a = await deps.prisma.application.findUnique({ where: { id: t.id }, select: { source: true, image: true } });
  if (!a || a.source !== "IMAGE" || a.image !== t.from) return { restored: false };
  await deps.apps.setSource(userId, t.id, { image: t.to });
  return { restored: true };
}
