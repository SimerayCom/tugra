import type { Command } from "commander";
import { activeClient } from "../session";
import { printJson, printLine, printTable } from "../output";

/**
 * `tugra coolify ...`: where the move off Coolify stands. Every sub-command is a read-only GET of one hub route through a pure
 * request builder (unit-tested without a network). Nothing here acts on a server: taking over, cleaning up, installing agents and
 * moving a project need the owner's typed confirmation and stay in the panel.
 */
export const COOLIFY_ACTIONS = ["status", "takeover", "consent", "campaigns", "cleanup", "ssh", "move"] as const;
export type CoolifyAction = (typeof COOLIFY_ACTIONS)[number];

export interface CoolifyOpts {
  team?: string;
  /** campaigns: one campaign id. */
  id?: string;
  /** ssh: one install run id. */
  run?: string;
  /** move: one project move id. */
  move?: string;
  /** consent: only this Tugra server's grants. */
  server?: string;
  json?: boolean;
}

export interface Req {
  method: "GET";
  path: string;
}

const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const seg = (v: string): string => encodeURIComponent(v);

/** The request each action maps to (1:1 with the hub endpoint). Always a GET. */
export function buildRequest(action: CoolifyAction, arg: string | undefined, o: CoolifyOpts): Req {
  switch (action) {
    case "status":
      need(o.team, "--team <teamId> is required");
      return { method: "GET", path: `/coolify-move/status?teamId=${seg(o.team!)}` };
    case "takeover":
      need(arg, "a server id is required");
      return { method: "GET", path: `/coolify-inplace?serverId=${seg(arg!)}` };
    case "consent":
      need(o.team, "--team <teamId> is required");
      return { method: "GET", path: `/coolify-takeover/secrets/grants?teamId=${seg(o.team!)}` };
    case "campaigns":
      if (o.id) return { method: "GET", path: `/migration-campaigns/${seg(o.id)}` };
      need(o.team, "--team <teamId> is required (or --id <campaignId>)");
      return { method: "GET", path: `/migration-campaigns?teamId=${seg(o.team!)}` };
    case "cleanup":
      need(arg, "a server id is required");
      return { method: "GET", path: `/coolify-cleanup/servers/${seg(arg!)}` };
    case "ssh":
      need(arg, "the Coolify host's server id is required");
      return { method: "GET", path: o.run ? `/coolify-takeover/servers/${seg(arg!)}/ssh/runs/${seg(o.run)}` : `/coolify-takeover/servers/${seg(arg!)}/ssh/runs/latest` };
    case "move":
      need(arg || o.move, "a project id is required (or --move <moveId>)");
      return { method: "GET", path: o.move ? `/project-moves/${seg(o.move)}` : `/project-moves/project/${seg(arg!)}` };
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The SSH install view without the probe facts (hashed host ids, fingerprints): a status needs names, states and fixed codes. Applied to
 * the table and to `--json`, so the CLI shows what the MCP tool shows.
 */
export function slimSsh(v: unknown): unknown {
  if (!isRec(v) || !Array.isArray(v.targets)) return v;
  return {
    runId: v.runId,
    finished: v.finished,
    expiresAt: v.expiresAt,
    targets: v.targets.filter(isRec).map((t) => ({ name: t.name, state: t.state, code: t.code ?? null, tugraServerId: t.tugraServerId ?? null, manualCommand: t.manualCommand === true, canRemove: t.canRemove === true })),
  };
}

/** `consent` shows the secrets consent only, for one server when asked. */
export function consentRows(v: unknown, server?: string): Rec[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRec).filter((g) => g.kind === "secrets" && (!server || g.serverId === server));
}

function print(action: CoolifyAction, res: unknown, o: CoolifyOpts): void {
  const data = action === "ssh" ? slimSsh(res) : action === "consent" ? consentRows(res, o.server) : res;
  if (o.json) return printJson(data);
  switch (action) {
    case "status": {
      const v = data as Rec;
      const steps = Array.isArray(v.steps) ? (v.steps as Rec[]) : [];
      for (const s of steps) printLine(`${String(s.step).padEnd(12)} ${s.done}/${s.total}${s.complete ? "  done" : ""}`);
      const hub = isRec(v.hub) ? v.hub : null;
      printLine(hub ? `Coolify host: ${hub.name} (read ${hub.readAt ?? "never"}, secrets consent ${hub.secrets})` : "Coolify host: not connected");
      printTable((Array.isArray(v.servers) ? v.servers : []) as Rec[], [
        { key: "name", header: "SERVER" },
        { key: "agentOnline", header: "AGENT" },
        { key: "takeover", header: "TAKEOVER" },
        { key: "cleanup", header: "CLEANUP" },
        { key: "stage", header: "NEXT" },
      ]);
      return;
    }
    case "takeover":
      return printTable(
        (Array.isArray(data) ? (data as Rec[]) : []).map((t) => ({ ...t, apps: Array.isArray(t.items) ? t.items.length : 0 })),
        [{ key: "id", header: "ID" }, { key: "status", header: "STATUS" }, { key: "apps", header: "APPS" }, { key: "failureCode", header: "FAILURE" }, { key: "createdAt", header: "STARTED" }],
      );
    case "consent":
      return printTable(data as Rec[], [{ key: "id", header: "ID" }, { key: "serverId", header: "SERVER" }, { key: "status", header: "STATUS" }, { key: "expiresAt", header: "ENDS" }]);
    case "campaigns": {
      const rows = Array.isArray(data) ? (data as Rec[]) : isRec(data) ? [data] : [];
      return printTable(rows.map((c) => ({ ...c, runs: Array.isArray(c.runIds) ? c.runIds.length : "" })), [{ key: "id", header: "ID" }, { key: "label", header: "LABEL" }, { key: "status", header: "STATUS" }, { key: "runs", header: "RUNS" }, { key: "createdAt", header: "CREATED" }]);
    }
    case "cleanup": {
      if (!isRec(data)) return printLine("no cleanup check yet");
      printLine(`cleanup ${data.id}: ${data.status}${data.complete === true ? " (complete)" : ""}`);
      return printTable((Array.isArray(data.completeness) ? data.completeness : []) as Rec[], [{ key: "kind", header: "KIND" }, { key: "coolify", header: "COOLIFY" }, { key: "tugra", header: "TUGRA" }]);
    }
    case "ssh": {
      if (!isRec(data)) return printLine("no install run yet");
      return printTable(data.targets as Rec[], [{ key: "name", header: "SERVER" }, { key: "state", header: "STATE" }, { key: "code", header: "CODE" }, { key: "manualCommand", header: "MANUAL" }]);
    }
    case "move": {
      const rows = Array.isArray(data) ? (data as Rec[]) : isRec(data) ? [data] : [];
      return printTable(rows, [{ key: "id", header: "ID" }, { key: "phase", header: "PHASE" }, { key: "failureCode", header: "FAILURE" }, { key: "createdAt", header: "STARTED" }]);
    }
  }
}

export function register(program: Command): void {
  program
    .command("coolify <action> [id]")
    .description(`Where the move off Coolify stands (read-only): ${COOLIFY_ACTIONS.join(" | ")}. status/consent/campaigns take --team; takeover/cleanup take a server id; ssh takes the Coolify host's server id; move takes a project id`)
    .option("--team <id>", "status/consent/campaigns: the team")
    .option("--id <id>", "campaigns: one campaign")
    .option("--run <id>", "ssh: one install run (default: the newest)")
    .option("--move <id>", "move: one project move")
    .option("--server <id>", "consent: only this server")
    .option("--json", "output as JSON")
    .action(async (action: string, arg: string | undefined, opts: CoolifyOpts) => {
      if (!(COOLIFY_ACTIONS as readonly string[]).includes(action)) throw new Error(`unknown action ${JSON.stringify(action)} (use ${COOLIFY_ACTIONS.join(", ")})`);
      const req = buildRequest(action as CoolifyAction, arg, opts);
      const res = await activeClient().client.requestRaw<unknown>(req.method, req.path);
      print(action as CoolifyAction, res, opts);
    });
}
