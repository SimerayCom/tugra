import * as readline from "node:readline";
import type { Command } from "commander";
import { activeClient } from "../session";
import { printJson, printLine } from "../output";
import type { RebootStatusShape, RebootViewShape, TugraClient } from "../client";

const MIN_LEAD_MS = 60_000;
const MAX_LEAD_MS = 7 * 24 * 60 * 60_000;

/**
 * `--at` as an ISO instant. Accepts:
 *   - an ISO date-time with a zone (`2026-12-01T03:00:00Z`, `...+03:00`);
 *   - a local date-time without one (`2026-12-01 03:00`, `2026-12-01T03:00`), read in THIS machine's time zone;
 *   - a relative time (`+30m`, `+2h`, `+1d`).
 * Throws a readable error for anything else, or for a time outside 1 minute .. 7 days from `now`.
 */
export function parseAt(input: string, now = Date.now()): string {
  const v = input.trim();
  let t = NaN;
  const rel = /^\+(\d+)([mhd])$/.exec(v);
  if (rel) {
    const unit = rel[2] === "m" ? 60_000 : rel[2] === "h" ? 3_600_000 : 86_400_000;
    t = now + Number(rel[1]) * unit;
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)) {
    t = new Date(v.replace(" ", "T")).getTime();
  }
  if (!Number.isFinite(t)) throw new Error(`cannot read --at ${JSON.stringify(input)}: use an ISO time (2026-12-01T03:00:00Z), a local time (2026-12-01 03:00) or +30m / +2h / +1d`);
  if (t < now + MIN_LEAD_MS) throw new Error("--at must be at least a minute from now");
  if (t > now + MAX_LEAD_MS) throw new Error("--at must be within the next 7 days");
  return new Date(t).toISOString();
}

export interface RebootDeps {
  client: Pick<TugraClient, "getServer" | "getServerRebootPreview" | "requestServerReboot">;
  /** Ask the person to type something; resolves with their answer. Only used when --yes is absent. */
  ask: (question: string) => Promise<string>;
  interactive: boolean;
  out: (line: string) => void;
}

export interface RebootOptions {
  at?: string;
  yes?: boolean;
  json?: boolean;
}

/** What a reboot takes down, in words (pure). */
export function impactLines(p: { containers: number; domains: number; hostsHub: boolean; agentOnline: boolean }): string[] {
  const lines = [`${p.containers} containers and ${p.domains} domains will be briefly unavailable.`];
  if (p.hostsHub) lines.push("This server also runs the Tugra hub: the panel goes away for 1 to 3 minutes.");
  if (!p.agentOnline) lines.push("The server's agent is offline right now, so the hub cannot start a reboot.");
  return lines;
}

/**
 * Reboot a server. The hub refuses unless `confirmName` equals the server's name, so the CLI collects that name from
 * the person (typed) — or, with `--yes`, takes it as given: `--yes` is the explicit "I mean this server" flag. Without
 * `--yes` and without a terminal there is nobody to ask, so it refuses rather than rebooting.
 */
export async function runReboot(deps: RebootDeps, id: string, opts: RebootOptions, now = Date.now()): Promise<RebootViewShape> {
  const at = opts.at !== undefined ? parseAt(opts.at, now) : undefined; // validate before any request
  const server = await deps.client.getServer(id);
  const name = String(server.name ?? "");
  if (!name) throw new Error("the hub did not return the server's name");
  const preview = await deps.client.getServerRebootPreview(id);
  if (!opts.json) for (const l of impactLines(preview)) deps.out(l);
  if (!opts.yes) {
    if (!deps.interactive) throw new Error("refusing to reboot without confirmation: run this in a terminal, or pass --yes");
    const typed = (await deps.ask(`Type the server name (${name}) to confirm the reboot: `)).trim();
    if (typed !== name) throw new Error("confirmation did not match the server name — nothing was rebooted");
  }
  return at
    ? deps.client.requestServerReboot(id, { mode: "scheduled", at, confirmName: name })
    : deps.client.requestServerReboot(id, { mode: "now", confirmName: name });
}

const STATE_TEXT: Record<string, string> = {
  SCHEDULED: "scheduled",
  STARTING: "starting",
  REBOOTING: "rebooting",
  WAITING_AGENT: "waiting for the agent",
  VERIFYING: "verifying",
  DONE: "done",
};

/** `reboot-status` as text (pure). */
export function formatRebootStatus(s: RebootStatusShape): string[] {
  const out: string[] = [];
  if (s.active) {
    const a = s.active;
    out.push(`state: ${STATE_TEXT[a.state] ?? a.state}${a.mode === "scheduled" && a.scheduledAt ? ` (for ${a.scheduledAt})` : ""}`);
    if (a.snapshot) out.push(`expected back: ${a.snapshot.containers} containers, ${a.snapshot.domains} domains${a.snapshot.hostsHub ? " (this server hosts the hub)" : ""}`);
  } else {
    out.push("no reboot in progress or scheduled");
  }
  const l = s.last;
  if (l) {
    out.push("", `last reboot: ${l.result ?? l.state}${l.verifiedAt ? ` (verified ${l.verifiedAt})` : ""}`);
    const r = l.report;
    if (r) {
      if (r.reason) out.push(`  reason: ${r.reason}`);
      out.push(`  containers ${r.summary.containersOk}/${r.summary.containersExpected} running, domains ${r.summary.domainsOk}/${r.summary.domainsExpected} answering, reboot-required flag ${r.rebootRequired}`);
      for (const c of r.containers) if (c.verdict !== "ok") out.push(`  container ${c.name}: ${c.verdict}${c.detail ? ` (${c.detail})` : ""}`);
      for (const d of r.domains) if (d.verdict !== "ok") out.push(`  domain ${d.host}: ${d.verdict}${d.status ? ` (${d.status})` : ""}`);
      if (r.domainsNote) out.push(`  note: domains ${r.domainsNote.replace(/_/g, " ")}`);
    }
  } else {
    out.push("", "no finished reboot yet");
  }
  return out;
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function register(program: Command): void {
  const servers = program.commands.find((c) => c.name() === "servers") ?? program.command("servers").description("Manage servers");
  servers.alias("server");

  servers
    .command("reboot <id>")
    .description("Reboot a server now, or at a time with --at. Asks you to type the server name unless --yes. Verified afterwards; see reboot-status (deploy scope)")
    .option("--at <time>", "schedule it: an ISO time, a local time (2026-12-01 03:00) or +30m / +2h / +1d (1 minute to 7 days ahead)")
    .option("--yes", "confirm without being asked (you mean this server)")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: RebootOptions) => {
      const { client } = activeClient();
      const res = await runReboot({ client, ask, interactive: !!process.stdin.isTTY, out: printLine }, id, opts);
      if (opts.json) printJson(res);
      else if (res.mode === "scheduled") printLine(`reboot scheduled for ${res.scheduledAt} — follow it with: tugra servers reboot-status ${id}`);
      else printLine(`rebooting in a few seconds — follow it with: tugra servers reboot-status ${id}`);
    });

  servers
    .command("reboot-status <id>")
    .description("Show the server's reboot state and the last verification (what came back, what did not)")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const status = await activeClient().client.getServerReboot(id);
      if (opts.json) printJson(status);
      else for (const l of formatRebootStatus(status)) printLine(l);
    });

  servers
    .command("reboot-cancel <id>")
    .description("Cancel a scheduled reboot (one that already started cannot be cancelled; deploy scope)")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const res = await activeClient().client.cancelServerReboot(id);
      if (opts.json) printJson(res);
      else printLine(`scheduled reboot of server ${id} cancelled`);
    });
}
