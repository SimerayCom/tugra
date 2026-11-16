/**
 * Multi-host placement of an import (P7 grup-7, R12): the pure helpers that turn the run's `serverMap` (source server ref,
 * the Coolify server uuid in an itemRef, to Tugra server id) into "which Tugra server does this item land on".
 *
 * The map is optional everywhere: absent or empty means a classic single-target import (everything lands on the default
 * `targetServerId`, byte-identical to before). Lookups are own-property only, so a source ref such as `__proto__` can never
 * resolve through the prototype chain.
 */
import { z } from "zod";

/** At most this many source servers in a map (the contract's own limit; the real fleet has 24 hosts). */
export const IMPORT_SERVER_MAP_MAX = 64;

const SourceServerRef = z
  .string()
  .regex(/^[\x21-\x7e]{1,200}$/, "invalid source server ref")
  .refine((k) => k !== "__proto__" && k !== "constructor" && k !== "prototype", "reserved key");

/** Source server ref to Tugra server id. Names and ids only: no secret. */
export const ImportServerMapSchema = z
  .record(SourceServerRef, z.string().min(1).max(64))
  .refine((m) => Object.keys(m).length <= IMPORT_SERVER_MAP_MAX, `at most ${IMPORT_SERVER_MAP_MAX} source servers`);
export type ImportServerMap = z.infer<typeof ImportServerMapSchema>;

const own = (m: Readonly<Record<string, string>>, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);

/** True for a map that actually places something (a missing or empty map is a single-target import). */
export const hasServerMap = (m: Readonly<Record<string, string>> | null | undefined): m is Readonly<Record<string, string>> => !!m && Object.keys(m).length > 0;

/** The Tugra server a resource from source server `ref` lands on: the mapped one, else the default. */
export function placementFor(defaultId: string, map: Readonly<Record<string, string>> | null | undefined, ref: string | null | undefined): string {
  if (!ref || !map) return defaultId;
  return own(map, ref) ?? defaultId;
}

/** Every Tugra target of an import: the default first, then each mapped server once. */
export function placementTargets(defaultId: string, map: Readonly<Record<string, string>> | null | undefined): string[] {
  const out = [defaultId];
  for (const id of Object.values(map ?? {})) if (!out.includes(id)) out.push(id);
  return out;
}

/** The source servers of `refs` that a NON-EMPTY map does not place (they would silently land on the default). */
export function unplacedRefs(map: Readonly<Record<string, string>> | null | undefined, refs: Iterable<string | undefined | null>): string[] {
  if (!hasServerMap(map)) return [];
  const out = new Set<string>();
  for (const r of refs) if (r && own(map, r) === undefined) out.add(r);
  return [...out].sort();
}

/** The source server ref of a plan itemRef `<kind>:<serverRef|_>:<sourceRef>`, or undefined for an unknown placement (`_`). */
export function serverRefOfItemRef(itemRef: string): string | undefined {
  const i1 = itemRef.indexOf(":");
  if (i1 < 0) return undefined;
  const i2 = itemRef.indexOf(":", i1 + 1);
  if (i2 < 0) return undefined;
  const ref = itemRef.slice(i1 + 1, i2);
  return ref && ref !== "_" ? ref : undefined;
}
