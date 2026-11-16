/**
 * What the plan has in object storage (R33), read from the op's own rows: the imported MinIO services (by the member names the
 * importer stored in the task result) and the apps whose env NAMES an object store. Only names leave this module: an env is
 * decrypted to list its keys and nothing else is read or kept. An env that cannot be read is counted (`unreadable`), never read as
 * "no keys": the gate treats such an app as a possible dependant, so the check fails closed like the cutover holds do.
 */
import type { CryptoService } from "../../../../crypto/crypto.service";
import type { PrismaService } from "../../../../prisma/prisma.service";
import { objectStoreKeys } from "../../cutover/cutover-holds";
import { isMinioResult } from "../../cutover/cutover-world.service";
import type { ObjectStorageFacts, SourceItem } from "../data-contract";

export interface FactTask {
  itemRef: string | null;
  kind: string;
  status: string;
  resourceType: string | null;
  resourceId: string | null;
  result: unknown;
}

export async function objectStorageFacts(prisma: Pick<PrismaService, "application">, crypto: Pick<CryptoService, "decrypt"> | undefined, tasks: readonly FactTask[], nameOf: ReadonlyMap<string, string>): Promise<ObjectStorageFacts> {
  const named = (t: FactTask): SourceItem => ({ itemRef: t.itemRef as string, name: t.resourceId ? (nameOf.get(t.resourceId) ?? null) : null });
  const stores = tasks.filter((t) => t.kind === "service" && t.status === "DONE" && !!t.itemRef && isMinioResult(t.result)).map(named);
  const apps = tasks.filter((t) => t.kind === "app" && t.status === "DONE" && t.resourceType === "application" && !!t.resourceId && !!t.itemRef);
  const dependants: SourceItem[] = [];
  let unreadable = 0;
  if (apps.length > 0) {
    if (!crypto) unreadable = apps.length;
    else {
      const rows = await prisma.application.findMany({ where: { id: { in: apps.map((a) => a.resourceId as string) } }, select: { id: true, env: true, envEnc: true } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const a of apps) {
        const r = byId.get(a.resourceId as string);
        if (!r) continue;
        try {
          const env = r.envEnc ? (JSON.parse(crypto.decrypt(r.envEnc)) as Record<string, unknown>) : ((r.env ?? {}) as Record<string, unknown>);
          if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("env is not an object");
          if (objectStoreKeys(Object.keys(env)).length > 0) dependants.push(named(a));
        } catch {
          unreadable++;
        }
      }
    }
  }
  const byRef = (a: SourceItem, b: SourceItem): number => (a.itemRef < b.itemRef ? -1 : a.itemRef > b.itemRef ? 1 : 0);
  return { stores: stores.sort(byRef), dependants: dependants.sort(byRef), unreadable };
}
