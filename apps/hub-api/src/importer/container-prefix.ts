/**
 * The custom container name prefix of a Coolify application (`settings.custom_container_name_prefix`).
 *
 * Coolify names an application's container `<uuid>-<deploy timestamp>`, or `<prefix>-<deploy timestamp>` when the app has a
 * custom prefix. The importer's item ref carries only the uuid (`app:<serverRef|_>:<uuid>`), so everything that finds the source
 * container by name (the freeze, the host inventory cross-check, the image pins, the migrator's volume resolver) has to be told the
 * prefix separately. It travels as `proposed.containerPrefix` of the plan's app item: a plain, shell-safe name that is validated
 * here once, so no consumer ever interpolates a value this module did not accept.
 *
 * Coolify 4.7.5 itself only allows lowercase letters, digits and single hyphens (at most 30 characters) and keeps a prefix unique per
 * server; an older stored value can be anything, so a value outside this pattern is DROPPED (the app is then matched by its uuid only
 * and the freeze reports the container as unresolved rather than guessing a name).
 */
export const CONTAINER_PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const validContainerPrefix = (v: unknown): v is string => typeof v === "string" && CONTAINER_PREFIX_RE.test(v);

/** `itemRef -> prefix` of the `app` items of a stored plan (`BulkOperation.meta.plan.items`). Tolerant: anything malformed is skipped. */
export function containerPrefixesOf(planItems: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(planItems)) return out;
  for (const it of planItems as Array<{ itemRef?: unknown; kind?: unknown; proposed?: { containerPrefix?: unknown } | null }>) {
    if (it?.kind === "app" && typeof it.itemRef === "string" && validContainerPrefix(it.proposed?.containerPrefix)) out.set(it.itemRef, it.proposed!.containerPrefix as string);
  }
  return out;
}
