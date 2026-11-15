import type { Command } from "commander";
import { activeClient } from "../session";
import { printJson, printLine, printTable } from "../output";

/** Secret keys never travel as flags (shell history / process list): they are read from these environment variables. */
export const SRC_SECRET_ENV = "TUGRA_OBJ_SRC_SECRET_KEY";
export const DST_SECRET_ENV = "TUGRA_OBJ_DST_SECRET_KEY";

/** `a=x,b=y` pairs → a map; the first `=` splits (values may contain `=`). */
export function parsePairs(raw: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of raw ?? []) {
    const eq = p.indexOf("=");
    if (eq < 1) throw new Error(`expected BUCKET=VALUE, got ${JSON.stringify(p)}`);
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

const csv = (v: string | undefined): string[] => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

interface ObjBucket { srcBucket: string; dstBucket: string; selected: boolean; exclude: string[]; status?: string; srcObjects?: number | null; srcBytes?: number | null }
interface ObjView { id: string; name: string; status: string; buckets: ObjBucket[]; [k: string]: unknown }

const api = () => activeClient().client;
const base = (id: string) => `/object-migrations/${encodeURIComponent(id)}`;

export function register(program: Command): void {
  // ── import git-links ──
  const imp = program.command("import").description("Fleet import helpers");
  imp
    .command("git-links")
    .description("Show how each git app of a connected import source would be linked on the target server's team (repo-visibility matching)")
    .requiredOption("--session <id>", "the import session id (from the import wizard / POST /import/connect)")
    .requiredOption("--server <id>", "the target Tugra server id")
    .option("--json", "output as JSON")
    .action(async (opts: { session: string; server: string; json?: boolean }) => {
      const res = await api().requestRaw<{ rows: Array<Record<string, unknown>>; groups: Array<Record<string, unknown>> }>("POST", "/import/git-links", { sessionId: opts.session, targetServerId: opts.server });
      if (opts.json) return printJson(res);
      printTable(res.groups, [
        { key: "host", header: "HOST" },
        { key: "owner", header: "OWNER" },
        { key: "status", header: "STATUS" },
        { key: "apps", header: "APPS" },
        { key: "sourceName", header: "SOURCE" },
      ]);
    });

  // ── objects (S3/MinIO migration) ──
  const obj = program.command("objects").description("S3/MinIO object migration (mc mirror run by the target server's agent)");
  obj
    .command("ls")
    .description("List object migrations")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const rows = await api().requestRaw<ObjView[]>("GET", "/object-migrations");
      if (opts.json) return printJson(rows);
      printTable(rows.map((m) => ({ id: m.id, name: m.name, status: m.status, buckets: m.buckets.filter((b) => b.selected).length })), [
        { key: "id", header: "ID" },
        { key: "name", header: "NAME" },
        { key: "status", header: "STATUS" },
        { key: "buckets", header: "SELECTED" },
      ]);
    });
  obj
    .command("create")
    .description(`Create a migration. Secret keys are read from $${SRC_SECRET_ENV} and $${DST_SECRET_ENV}, never from flags.`)
    .requiredOption("--name <name>", "a name for this migration")
    .requiredOption("--server <id>", "the target server whose agent runs the copy")
    .requiredOption("--source <endpoint>", "source S3 endpoint, e.g. https://s3.old.example.com")
    .requiredOption("--source-access-key <key>", "source access key (a read-only key is enough)")
    .requiredOption("--destination <endpoint>", "destination S3 endpoint (a same-host MinIO: http://host.docker.internal:9100)")
    .requiredOption("--destination-access-key <key>", "destination access key")
    .option("--no-preserve", "do not preserve object attributes / bucket policy (mc --preserve)")
    .option("--json", "output as JSON")
    .action(async (o: { name: string; server: string; source: string; sourceAccessKey: string; destination: string; destinationAccessKey: string; preserve: boolean; json?: boolean }) => {
      const srcSecret = process.env[SRC_SECRET_ENV];
      const dstSecret = process.env[DST_SECRET_ENV];
      if (!srcSecret || !dstSecret) throw new Error(`set $${SRC_SECRET_ENV} and $${DST_SECRET_ENV} (secret keys are never passed as flags)`);
      const m = await api().requestRaw<ObjView>("POST", "/object-migrations", {
        name: o.name,
        targetServerId: o.server,
        preserve: o.preserve,
        source: { endpoint: o.source, accessKey: o.sourceAccessKey, secretKey: srcSecret },
        destination: { endpoint: o.destination, accessKey: o.destinationAccessKey, secretKey: dstSecret },
      });
      if (o.json) return printJson(m);
      printLine(`created ${m.id}; next: tugra objects preflight ${m.id}`);
    });
  obj
    .command("status <id>")
    .description("Show a migration's status and per-bucket progress")
    .option("--json", "output as JSON")
    .action(async (id: string, o: { json?: boolean }) => {
      const m = await api().requestRaw<ObjView>("GET", base(id));
      if (o.json) return printJson(m);
      printLine(`${m.name}  ${m.status}`);
      printTable(m.buckets as unknown as Array<Record<string, unknown>>, [
        { key: "srcBucket", header: "BUCKET" },
        { key: "dstBucket", header: "DEST" },
        { key: "selected", header: "SELECTED" },
        { key: "status", header: "STATUS" },
        { key: "srcObjects", header: "OBJECTS" },
        { key: "srcBytes", header: "BYTES" },
      ]);
    });
  for (const [name, path, desc] of [
    ["preflight", "preflight", "Probe both endpoints and size every bucket (nothing is selected)"],
    ["verify", "verify", "mc diff per selected bucket: compares keys and sizes (not a content hash)"],
    ["carry-config", "carry-config", "Apply the exported policy / lifecycle / tags to the destination buckets"],
    ["cancel", "cancel", "Cancel the running copy (a later start resumes)"],
  ] as const) {
    obj
      .command(`${name} <id>`)
      .description(desc)
      .option("--json", "output as JSON")
      .action(async (id: string, o: { json?: boolean }) => {
        const m = await api().requestRaw<ObjView>("POST", `${base(id)}/${path}`);
        if (o.json) return printJson(m);
        printLine(`${m.name}: ${m.status}`);
      });
  }
  obj
    .command("buckets <id>")
    .description("Choose the buckets to copy (nothing is pre-selected)")
    .requiredOption("--select <names>", "comma-separated source buckets to select (every other bucket is deselected)")
    .option("--rename <pair...>", "SRC=DST destination name for a bucket")
    .option("--exclude <pair...>", "SRC=GLOB exclude glob for a bucket (repeatable)")
    .option("--json", "output as JSON")
    .action(async (id: string, o: { select: string; rename?: string[]; exclude?: string[]; json?: boolean }) => {
      const current = await api().requestRaw<ObjView>("GET", base(id));
      const want = new Set(csv(o.select));
      const rename = parsePairs(o.rename);
      const excl: Record<string, string[]> = {};
      for (const p of o.exclude ?? []) {
        const eq = p.indexOf("=");
        if (eq < 1) throw new Error(`expected SRC=GLOB, got ${JSON.stringify(p)}`);
        (excl[p.slice(0, eq)] ||= []).push(p.slice(eq + 1));
      }
      for (const w of want) if (!current.buckets.some((b) => b.srcBucket === w)) throw new Error(`unknown source bucket: ${w}`);
      const m = await api().requestRaw<ObjView>("PUT", `${base(id)}/buckets`, {
        buckets: current.buckets.map((b) => ({ srcBucket: b.srcBucket, selected: want.has(b.srcBucket), ...(rename[b.srcBucket] ? { dstBucket: rename[b.srcBucket] } : {}), ...(excl[b.srcBucket] ? { exclude: excl[b.srcBucket] } : {}) })),
      });
      if (o.json) return printJson(m);
      printLine(`${m.buckets.filter((b) => b.selected).length} bucket(s) selected`);
    });
  obj
    .command("start <id>")
    .description("Start the seed copy (live, copies missing keys only) or the final pass")
    .option("--phase <phase>", "seed or final", "seed")
    .option("--ack-writes-frozen", "REQUIRED for the final pass: confirm the writers are stopped (writes after the pass are not copied)")
    .option("--remove", "final pass only: also delete destination objects that are not on the source (mc --remove)")
    .option("--merge", "acknowledge copying into destination buckets that already have objects")
    .option("--json", "output as JSON")
    .action(async (id: string, o: { phase: string; ackWritesFrozen?: boolean; remove?: boolean; merge?: boolean; json?: boolean }) => {
      if (o.phase !== "seed" && o.phase !== "final") throw new Error("--phase must be seed or final");
      const m = await api().requestRaw<ObjView>("POST", `${base(id)}/start`, {
        phase: o.phase,
        ...(o.ackWritesFrozen ? { acknowledgeWritesFrozen: true } : {}),
        ...(o.remove ? { removeExtraneous: true } : {}),
        ...(o.merge ? { mergeIntoExisting: true } : {}),
      });
      if (o.json) return printJson(m);
      printLine(`${m.name}: ${m.status}`);
    });
}
