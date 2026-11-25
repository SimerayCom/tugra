import { z } from "zod";
import { shq } from "../deploy/deploy-script";

/**
 * PM2 facts: what the in-place mover needs to know about the saved PM2 processes of a host. They come from the agent
 * image's `pm2` subcommand, run in the same sandboxed helper as the server scan (host root READ-ONLY, no capabilities
 * beyond DAC_READ_SEARCH, no pm2 binary, no daemon). The LISTING never carries an environment value (a key count and a
 * digest only); the environment of ONE named process is read for the move itself.
 * Everything the agent prints is UNTRUSTED: each field is matched against a strict schema before the planner sees it.
 */

export const PM2_BEGIN = "TUGRA_PM2_BEGIN";
export const PM2_END = "TUGRA_PM2_END";
export const PM2_UNAVAILABLE = "TUGRA_PM2_UNAVAILABLE";
export const PM2_FAILED = "TUGRA_PM2_FAILED";
export const PM2_OUTDATED = "TUGRA_PM2_OUTDATED";
export const PM2_TOOLARGE = "TUGRA_PM2_TOOLARGE";
/** The most stdout the hub keeps from the helper. The agent stays below it on its own (it drops processes, or refuses an oversized environment), so a cut document is never passed on. */
export const PM2_MAX_OUT = 48000;
export const PM2_PROBE_REPLY = "tugra-pm2-v1";

/** A PM2 account directory name (the user part of /home/<user>/.pm2) as the facts subcommand reports it. */
export const PM2_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** A process name that is safe to hand to `pm2 <op> <name>` (never an option, a number, or a PM2 selector word). */
export const PM2_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._@:+-]{0,119}$/;
const PM2_RESERVED_NAMES = new Set(["all", "default"]);

export function isSafePm2Name(name: string): boolean {
  return PM2_NAME_RE.test(name) && !/^\d+$/.test(name) && !PM2_RESERVED_NAMES.has(name.toLowerCase()) && name === name.trim() && !name.includes("  ");
}

export type Pm2FactsFailure = "unavailable" | "outdated" | "failed" | "toolarge";

/**
 * The facts probe: the agent's OWN image (from the trusted $TUGRA_AGENT_IMAGE only, `--pull never`) run read-only with the
 * host root mounted read-only. `user`/`name` narrow the output; `withEnv` (needs both) asks for that one process's
 * environment. The two narrowing values are validated here and shell-quoted, so nothing can break out of the command.
 */
export function buildPm2FactsScript(opts: { user?: string; name?: string; withEnv?: boolean } = {}): string {
  if (opts.user !== undefined && !PM2_USER_RE.test(opts.user)) throw new Error("invalid pm2 user");
  if (opts.name !== undefined && !isSafePm2Name(opts.name)) throw new Error("invalid pm2 process name");
  if (opts.withEnv && (opts.user === undefined || opts.name === undefined)) throw new Error("an environment read needs a user and a name");
  const narrow = [
    opts.user !== undefined ? shq(`--user=${opts.user}`) : "",
    opts.name !== undefined ? shq(`--name=${opts.name}`) : "",
    opts.withEnv ? "--env" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    'IMG="$TUGRA_AGENT_IMAGE"',
    `[ -n "$IMG" ] || { echo "${PM2_UNAVAILABLE} reason=no-image"; exit 0; }`,
    'for o in $(timeout 10 docker ps -aq --filter label=tugra.role=pm2-facts-helper 2>/dev/null); do timeout 10 docker rm -f "$o" >/dev/null 2>&1; done',
    'pn="tugra-pm2-$$-$(date +%s)"',
    `echo ${PM2_BEGIN}`,
    'out=$(timeout -k 5 40 docker run --rm --pull never --name "$pn" --label tugra.role=pm2-facts-helper \\',
    "  --network none --pid host --userns host --read-only --cap-drop ALL --cap-add DAC_READ_SEARCH \\",
    "  --security-opt no-new-privileges --security-opt label=disable --pids-limit 32 --memory 128m \\",
    `  -v /:/host:ro --entrypoint tugra-agent "$IMG" pm2 --root=/host --proc=/proc ${narrow} 2>/dev/null); rc=$?`,
    '[ $rc -eq 0 ] || { timeout 10 docker rm -f "$pn" >/dev/null 2>&1;',
    '  pr=$(timeout 20 docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 16 --memory 64m --entrypoint tugra-agent "$IMG" pm2 --probe 2>/dev/null);',
    // rc 3 = the agent refused an environment larger than one reply can carry (it never cuts a document).
    `  if [ "$pr" = "${PM2_PROBE_REPLY}" ]; then if [ $rc -eq 3 ]; then echo "${PM2_TOOLARGE}"; else echo "${PM2_FAILED} rc=$rc"; fi; else echo "${PM2_OUTDATED} rc=$rc"; fi; }`,
    // Never cut a document: more than the cap is reported as such, not passed on as broken JSON.
    `if [ $rc -eq 0 ]; then n=$(printf '%s' "$out" | wc -c); if [ "$n" -le ${PM2_MAX_OUT} ]; then printf '%s\\n' "$out"; else echo "${PM2_TOOLARGE}"; fi; fi`,
    `echo ${PM2_END}`,
    "exit 0",
  ]
    .join("\n");
}

// ── schemas ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const port = z.number().int().min(1).max(65535);
const id = z.number().int().min(0).max(2_147_483_647);
const argv = z.array(z.string().max(2000)).max(64);

const FactSchema = z.object({
  name: z.string().min(1).max(120),
  nameExact: z.boolean(),
  status: z.enum(["online", "stopped"]),
  script: z.string().max(1024).optional().default(""),
  cwd: z.string().max(1024).optional().default(""),
  interpreter: z.string().max(1024).optional().default(""),
  mode: z.enum(["fork", "cluster"]).optional(),
  instances: z.number().int().min(1).max(1023).optional().default(1),
  argsOverflow: z.boolean().optional().default(false),
  args: argv.optional().default([]),
  nodeArgs: argv.optional().default([]),
  interpreterArgs: argv.optional().default([]),
  uid: id.optional(),
  gid: id.optional(),
  /** Supplementary group ids of the account the process runs as (from the host's /etc/group); absent on an older agent. */
  groups: z.array(id).max(32).optional().default([]),
  port: port.optional(),
  envCount: z.number().int().min(0).max(100000),
  envSkipped: z.number().int().min(0).max(100000).optional().default(0),
  envDigest: z.string().regex(/^[0-9a-f]{64}$/),
  env: z.record(z.string(), z.string().max(100_000)).optional(),
  nvmrc: z.string().max(40).optional().default(""),
  enginesNode: z.string().max(60).optional().default(""),
  cwdExists: z.boolean().optional().default(false),
  scriptExists: z.boolean().optional().default(false),
  cwdUid: id.optional().default(0),
  cwdGid: id.optional().default(0),
});
export type Pm2Fact = z.infer<typeof FactSchema>;

const UserSchema = z.object({
  user: z.string().regex(PM2_USER_RE),
  home: z.string().regex(/^\/(root|home\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})$/),
  uid: id,
  gid: id,
  daemon: z.boolean(),
  procs: z.array(z.unknown()).max(100),
});
export interface Pm2FactsUser {
  user: string;
  home: string;
  uid: number;
  gid: number;
  daemon: boolean;
  procs: Pm2Fact[];
}

export type Pm2FactsResult = { status: "ok"; users: Pm2FactsUser[]; truncated: boolean } | { status: "unavailable"; reason: Pm2FactsFailure };

/** The probe's stdout → facts. A malformed user or process is dropped on its own; the rest of the document survives. */
export function parsePm2Facts(output: string): Pm2FactsResult {
  if (output.includes(PM2_OUTDATED)) return { status: "unavailable", reason: "outdated" };
  if (output.includes(PM2_TOOLARGE)) return { status: "unavailable", reason: "toolarge" };
  if (output.includes(PM2_FAILED) || output.includes(PM2_UNAVAILABLE)) return { status: "unavailable", reason: output.includes(PM2_UNAVAILABLE) ? "unavailable" : "failed" };
  const lines = output.split(/\r?\n/);
  const begin = lines.findIndex((l) => l.trim() === PM2_BEGIN);
  const end = lines.findIndex((l, i) => i > begin && l.trim() === PM2_END);
  if (begin < 0 || end < 0) return { status: "unavailable", reason: "failed" };
  let doc: unknown;
  try {
    doc = JSON.parse(lines.slice(begin + 1, end).join("\n"));
  } catch {
    return { status: "unavailable", reason: "failed" };
  }
  const root = z.object({ v: z.literal(1), users: z.array(z.unknown()).max(50), errors: z.array(z.string().max(40)).max(20).optional().default([]) }).safeParse(doc);
  if (!root.success) return { status: "unavailable", reason: "failed" };
  const users: Pm2FactsUser[] = [];
  for (const raw of root.data.users) {
    const u = UserSchema.safeParse(raw);
    if (!u.success) continue;
    const procs: Pm2Fact[] = [];
    for (const p of u.data.procs) {
      const r = FactSchema.safeParse(p);
      if (r.success) procs.push(r.data);
    }
    users.push({ user: u.data.user, home: u.data.home, uid: u.data.uid, gid: u.data.gid, daemon: u.data.daemon, procs });
  }
  return { status: "ok", users, truncated: root.data.errors.includes("truncated") };
}
