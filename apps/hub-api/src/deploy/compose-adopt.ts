/**
 * A compose project ADOPTED IN PLACE: it was started on the server by `docker compose` (its containers carry the
 * `com.docker.compose.*` labels) and Tugra takes it over WITHOUT recreating anything. The registration keeps the project
 * name, its working directory and the config files as they are on the host; every later Tugra command runs
 * `docker compose -p <project> -f <the same files>` against them, so compose finds the very same containers.
 *
 * The files live on the HOST, but the agent runs in a container that sees only /etc/tugra and the docker socket. So each
 * command runs in a short-lived helper container of the agent's OWN image (`$TUGRA_AGENT_IMAGE`, never anything else,
 * `--pull never`) that mounts the project's directories READ-ONLY at the same paths (bind sources in the files resolve
 * to the same host paths the daemon sees) plus the docker socket. Nothing here is ever written into the user's project.
 *
 * Everything that reaches a shell is validated here (strict charsets, no `..`, a deny-list of system roots) and quoted.
 */

import { posix } from "node:path";
import { z } from "zod";

/** Docker compose's own project-name charset (lower-case; it normalises everything else away). */
export const COMPOSE_PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** An absolute host path Tugra will carry into a shell: no spaces, quotes, `$`, backticks, `;`, globs. */
export const HOST_PATH_RE = /^\/[A-Za-z0-9._+/-]+$/;
const SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const MAX_ADOPT_FILES = 8;

/** Where a project can NOT be adopted from: system roots, the docker engine's own state, Tugra's own state, other platforms' trees. */
const DENIED_ROOTS = ["/proc", "/sys", "/dev", "/boot", "/run", "/var/run", "/var/lib/docker", "/bin", "/sbin", "/lib", "/lib64", "/usr", "/etc/tugra"];
/** Directories whose projects another platform owns (adopting them would fight it). */
const FOREIGN_TREES: { prefix: string; platform: "coolify" | "dokploy" }[] = [
  { prefix: "/data/coolify", platform: "coolify" },
  { prefix: "/etc/dokploy", platform: "dokploy" },
  { prefix: "/var/lib/dokploy", platform: "dokploy" },
];

export type AdoptPathProblem = "syntax" | "too_shallow" | "denied";

/** Why a host path cannot be mounted for an adopted project, or null when it is fine. */
export function adoptPathProblem(path: string): AdoptPathProblem | null {
  if (path.length > 240 || !HOST_PATH_RE.test(path) || path.includes("//")) return "syntax";
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return "syntax";
  if (posix.normalize(path) !== path.replace(/\/+$/, "")) return "syntax";
  if (path.split("/").filter(Boolean).length < 2) return "too_shallow"; // `/opt`, `/srv`: a whole top-level tree, never a project
  const p = path.replace(/\/+$/, "");
  if (DENIED_ROOTS.some((r) => p === r || p.startsWith(`${r}/`))) return "denied";
  return null;
}

/** The platform that owns a project directory (Coolify / Dokploy trees), or null. */
export function foreignProjectDir(path: string): "coolify" | "dokploy" | null {
  const p = path.replace(/\/+$/, "");
  for (const t of FOREIGN_TREES) if (p === t.prefix || p.startsWith(`${t.prefix}/`)) return t.platform;
  return null;
}

const Sha = z.string().regex(/^[a-f0-9]{64}$/);

export const ComposeAdoptSchema = z.object({
  v: z.literal(1),
  project: z.string().regex(COMPOSE_PROJECT_RE),
  workingDir: z.string().refine((p) => adoptPathProblem(p) === null),
  files: z
    .array(z.object({ path: z.string().refine((p) => adoptPathProblem(p) === null), sha256: Sha, bytes: z.number().int().min(0).max(100_000_000) }))
    .min(1)
    .max(MAX_ADOPT_FILES),
  /** What the project ran when it was adopted: shown in the UI, never used to build a command. */
  services: z
    .array(
      z.object({
        name: z.string().regex(SERVICE_RE),
        image: z.string().max(255),
        ports: z.array(z.number().int().min(1).max(65535)).max(20),
        volumes: z.array(z.object({ name: z.string().max(128), target: z.string().max(256) })).max(30),
      }),
    )
    .max(100),
  adoptedAt: z.string().max(40),
});
export type ComposeAdopt = z.infer<typeof ComposeAdoptSchema>;

/** A stored `composeAdopt` column → the strict shape, or null (not adopted / corrupt: fail closed to "not adopted"). */
export function parseComposeAdopt(raw: unknown): ComposeAdopt | null {
  if (raw === null || raw === undefined || typeof raw !== "object") return null;
  const r = ComposeAdoptSchema.safeParse(raw);
  return r.success ? r.data : null;
}

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** The trusted helper image, or fail closed (an agent that does not know its own image cannot run helpers). */
export const ADOPT_IMAGE_PRELUDE: string[] = [
  'IMG="$TUGRA_AGENT_IMAGE"',
  '[ -n "$IMG" ] || { echo "TUGRA_COMPOSE_UNAVAILABLE reason=no-image"; exit 1; }',
];

/** The distinct directories a helper must see: the working dir and every config file's directory. */
export function adoptMountDirs(a: Pick<ComposeAdopt, "workingDir" | "files">): string[] {
  return [...new Set([a.workingDir, ...a.files.map((f) => posix.dirname(f.path))])];
}

function mountArgs(a: Pick<ComposeAdopt, "workingDir" | "files">): string {
  return adoptMountDirs(a)
    .map((d) => `-v ${shq(`${d}:${d}:ro`)}`)
    .join(" ");
}

const HELPER_FLAGS =
  "--rm --pull never --label tugra.role=compose-helper --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges --security-opt label=disable";

/**
 * `docker compose <sub>` for an adopted project, run in a helper container. `sub` is a hub-built literal (up/stop/logs…),
 * never client text. The project directory and every `-f` file are the registered, validated host paths.
 */
export function adoptedComposeCmd(a: ComposeAdopt, sub: string): string {
  const files = a.files.map((f) => `-f ${shq(f.path)}`).join(" ");
  return [
    `docker run ${HELPER_FLAGS} \\`,
    `  -v /var/run/docker.sock:/var/run/docker.sock ${mountArgs(a)} -w ${shq(a.workingDir)} \\`,
    `  --entrypoint docker "$IMG" compose --project-directory ${shq(a.workingDir)} -p ${shq(a.project)} ${files} ${sub}`,
  ].join("\n");
}

/** A whole adopted-project command: the image prelude plus the helper run. */
export function adoptedComposeScript(a: ComposeAdopt, sub: string, extra: string[] = []): string {
  return [...ADOPT_IMAGE_PRELUDE, ...extra, adoptedComposeCmd(a, sub)].join("\n");
}

// ── reading the files from the host (adopt time) ───────────────────────────────────────────────────────────────────

export const FILE_MARK = "TUGRA_ADOPT_FILE";
const CONTENT_BEGIN = "TUGRA_ADOPT_CONTENT_BEGIN";
const CONTENT_END = "TUGRA_ADOPT_CONTENT_END";
/** Raw bytes of a file whose declared services are read (bigger files are only fingerprinted). */
export const MAX_READ_BYTES = 16384;

/**
 * Read-only look at the registered files: size, sha256 and (for small files) the content, which the hub parses for the
 * declared service names and then DISCARDS (never stored: compose files can hold inline secrets). No network, read-only
 * mounts, no capabilities but DAC_READ_SEARCH. The inner script is a constant; the paths arrive as positional arguments.
 */
export function buildAdoptReadScript(a: Pick<ComposeAdopt, "workingDir" | "files">): string {
  const inner = [
    "i=0",
    'for f in "$@"; do',
    "  i=$((i+1))",
    '  if [ -f "$f" ] && [ -r "$f" ]; then',
    '    sz=$(wc -c < "$f" | tr -d " "); h=$(sha256sum "$f" | cut -d" " -f1)',
    `    echo "${FILE_MARK} $i ok $sz $h"`,
    `    if [ "$sz" -le ${MAX_READ_BYTES} ]; then echo ${CONTENT_BEGIN}; base64 -w0 "$f"; echo; echo ${CONTENT_END}; fi`,
    "  else",
    `    echo "${FILE_MARK} $i missing 0 -"`,
    "  fi",
    "done",
  ].join("\n");
  const files = a.files.map((f) => shq(f.path)).join(" ");
  return [
    ...ADOPT_IMAGE_PRELUDE,
    `timeout -k 5 30 docker run --rm --pull never --network none --label tugra.role=compose-helper --cap-drop ALL --cap-add DAC_READ_SEARCH \\`,
    `  --security-opt no-new-privileges --security-opt label=disable --pids-limit 32 --memory 64m ${mountArgs(a)} \\`,
    `  --entrypoint sh "$IMG" -c ${shq(inner)} sh ${files}`,
  ].join("\n");
}

export interface AdoptFileRead {
  ok: boolean;
  bytes: number;
  sha256: string;
  /** Decoded content of a small file (parse and drop), or null. */
  content: string | null;
}

/** The read script's output, index-aligned with the files; a missing/unparsable entry is `ok:false`. */
export function parseAdoptRead(output: string, count: number): AdoptFileRead[] {
  const out: AdoptFileRead[] = Array.from({ length: count }, () => ({ ok: false, bytes: 0, sha256: "", content: null }));
  const lines = output.split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const m = new RegExp(`^${FILE_MARK} (\\d{1,2}) (ok|missing) (\\d{1,12}) ([a-f0-9]{64}|-)$`).exec(lines[k].trim());
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= count || m[2] !== "ok" || m[4] === "-") continue;
    const entry = out[idx];
    entry.ok = true;
    entry.bytes = Number(m[3]);
    entry.sha256 = m[4];
    if (lines[k + 1]?.trim() === CONTENT_BEGIN) {
      const b64 = lines[k + 2]?.trim() ?? "";
      if (/^[A-Za-z0-9+/=]*$/.test(b64) && lines[k + 3]?.trim() === CONTENT_END) {
        entry.content = Buffer.from(b64, "base64").toString("utf8");
      }
    }
  }
  return out;
}
