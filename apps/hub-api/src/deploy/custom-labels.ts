import { BadRequestException } from "@nestjs/common";
import { dockerOptionLabels } from "./docker-options-safety";
import { CUSTOM_LABEL_KEY_RE, CUSTOM_LABEL_LIMITS, LABEL_NAMESPACE_WHY, reservedLabelNamespace } from "./label-namespaces";

export { CUSTOM_LABEL_KEY_RE, CUSTOM_LABEL_LIMITS };

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/**
 * Validate + normalise an app's custom container labels. Returns the clean `{key: value}` map (`{}` for null /
 * undefined) or throws a 400 naming the offending key. This is the ONE gate: the structured editor, the
 * deploy/rollback re-validation, the clone/view parsers and the script builders all call it, so a hand-edited
 * DB row fails closed instead of reaching a shell. `opts.dockerOptions` adds the collision check against raw
 * `--label` flags (skip it for swarm apps, where dockerOptions is not applied).
 */
export function assertSafeCustomLabels(labels: unknown, opts: { dockerOptions?: string | null } = {}): Record<string, string> {
  if (labels === null || labels === undefined) return {};
  if (typeof labels !== "object" || Array.isArray(labels)) throw new BadRequestException("custom labels must be a key/value object");
  const L = CUSTOM_LABEL_LIMITS;
  const entries = Object.entries(labels as Record<string, unknown>);
  if (entries.length > L.maxCount) throw new BadRequestException(`at most ${L.maxCount} custom labels per app`);
  const seen = new Map<string, string>();
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [key, value] of entries) {
    if (typeof value !== "string") throw new BadRequestException(`label "${key}" value must be a string`);
    if (key.length === 0 || key.length > L.keyMax) throw new BadRequestException(`label key "${key.slice(0, 40)}" must be 1-${L.keyMax} characters`);
    if (!CUSTOM_LABEL_KEY_RE.test(key)) {
      throw new BadRequestException(`label key "${key}" is invalid (use letters, digits and . _ / @ : -, starting with a letter or digit)`);
    }
    if (value.length > L.valueMax) throw new BadRequestException(`label "${key}" value is longer than ${L.valueMax} characters`);
    if (CONTROL_RE.test(value)) throw new BadRequestException(`label "${key}" value contains control characters`);
    const ns = reservedLabelNamespace(key);
    if (ns) throw new BadRequestException(`label "${key}" is in the reserved ${ns}* namespace (${LABEL_NAMESPACE_WHY[ns]})`);
    const lower = key.toLowerCase();
    const dup = seen.get(lower);
    if (dup !== undefined) throw new BadRequestException(`label "${key}" duplicates "${dup}" (label keys are case-insensitive)`);
    seen.set(lower, key);
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    out[key] = value;
  }
  if (bytes > L.totalBytes) throw new BadRequestException(`custom labels exceed ${L.totalBytes} bytes in total`);
  if (opts.dockerOptions) {
    for (const { key } of dockerOptionLabels(opts.dockerOptions)) {
      const hit = seen.get(key.toLowerCase());
      if (hit !== undefined) {
        throw new BadRequestException(`label "${hit}" is already set via --label in Custom Docker options; remove one`);
      }
    }
  }
  return out;
}

/** Keys sorted with plain `<` comparison (stable, locale-independent) so generated scripts are deterministic. */
function sortedEntries(labels: Record<string, string>): [string, string][] {
  return Object.keys(labels)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => [k, labels[k]]);
}

/** The shell flags for a classic `docker run`: `--label 'k=v'` per entry, sorted. "" for none (so the run line is
 *  byte-identical for an app without custom labels). Re-validates (fail closed) and shq()s every pair. */
export function customLabelArgs(labels: Record<string, string> | null | undefined): string {
  return customContainerLabelFlags(labels, "--label").join(" ");
}

/** The same pairs as separate flag/value words for the swarm create (`--container-label`) and update
 *  (`--container-label-add`) paths. Each element is one already-quoted `--flag 'k=v'` string. */
export function customContainerLabelFlags(
  labels: Record<string, string> | null | undefined,
  flag: "--label" | "--container-label" | "--container-label-add",
): string[] {
  const clean = assertSafeCustomLabels(labels);
  return sortedEntries(clean).map(([k, v]) => `${flag} ${shq(`${k}=${v}`)}`);
}
