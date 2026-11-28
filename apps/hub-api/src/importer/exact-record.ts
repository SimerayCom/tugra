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
import { isExactPinFor } from "./exact-image";

export interface ExactRecordDeps {
  prisma: Pick<PrismaService, "application" | "database">;
  apps: Pick<ApplicationsService, "setSource" | "setComposeFile">;
  databases: Pick<DatabasesService, "setImage">;
}

export type ExactTarget = { kind: "app" | "database"; id: string; ref: string } | { kind: "service"; id: string; members: Record<string, string> };

/**
 * The stored compose with the exact image of each member written in (`services.<member>.image`). Only a member of that repository that is
 * not on a digest yet changes, so a pin never swaps what a member runs. `null` when nothing changed or the compose does not parse.
 */
export function pinComposeMembers(composeFile: string, members: Record<string, string>): string | null {
  let doc: unknown;
  try {
    doc = parseYaml(composeFile, { merge: true, maxAliasCount: 50 });
  } catch {
    return null;
  }
  const services = (doc as { services?: Record<string, { image?: unknown }> } | null)?.services;
  if (!services || typeof services !== "object") return null;
  let changed = false;
  for (const [member, ref] of Object.entries(members)) {
    const def = services[member];
    if (def && typeof def.image === "string" && def.image !== ref && isExactPinFor(def.image, ref)) {
      def.image = ref;
      changed = true;
    }
  }
  return changed ? stringifyYaml(doc, { lineWidth: 0 }) : null;
}

export async function writeExactImage(deps: ExactRecordDeps, userId: string, target: ExactTarget): Promise<{ pinned: boolean }> {
  if (target.kind === "service") {
    const c = await deps.prisma.application.findUnique({ where: { id: target.id }, select: { source: true, composeFile: true } });
    if (!c || c.source !== "COMPOSE" || !c.composeFile) return { pinned: false };
    const next = pinComposeMembers(c.composeFile, target.members);
    if (!next) return { pinned: false };
    await deps.apps.setComposeFile(userId, target.id, next);
    return { pinned: true };
  }
  if (target.kind === "database") {
    const d = await deps.prisma.database.findUnique({ where: { id: target.id }, select: { image: true, status: true } });
    if (!d || d.status !== "NEW" || !isExactPinFor(d.image, target.ref)) return { pinned: false };
    return { pinned: (await deps.databases.setImage(userId, target.id, target.ref)).changed };
  }
  const a = await deps.prisma.application.findUnique({ where: { id: target.id }, select: { source: true, image: true } });
  if (!a || a.source !== "IMAGE" || !a.image || a.image === target.ref || !isExactPinFor(a.image, target.ref)) return { pinned: false };
  await deps.apps.setSource(userId, target.id, { image: target.ref });
  return { pinned: true };
}
