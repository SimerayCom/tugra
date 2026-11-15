import type { Command } from "commander";
import { activeClient } from "../session";
import { printJson, printLine, printTable } from "../output";
import type { Column } from "../output";
import type { ImportVolumesView, Row } from "../client";

function emit(rows: Row[], json: boolean | undefined, columns: Column[]): void {
  if (json) printJson(rows);
  else printTable(rows, columns);
}

/** `KEY=VALUE` words → pairs, splitting at the FIRST `=` (values may contain `=`; an empty value is allowed). */
export function parseLabelPairs(pairs: string[]): [string, string][] {
  return pairs.map((p) => {
    const eq = p.indexOf("=");
    if (eq < 1) throw new Error(`expected KEY=VALUE, got ${JSON.stringify(p)}`);
    return [p.slice(0, eq), p.slice(eq + 1)];
  });
}

/** Overlay `wanted` on `current`; a key that differs only by case replaces the existing one (the hub treats keys case-insensitively). */
function mergeLabels(current: Record<string, string>, wanted: [string, string][]): Record<string, string> {
  const out = { ...current };
  for (const [k, v] of wanted) {
    for (const existing of Object.keys(out)) if (existing.toLowerCase() === k.toLowerCase()) delete out[existing];
    out[k] = v;
  }
  return out;
}

/** One table row per streamed volume: state, progress, speed, ETA and the failure text (pure, for `import volumes`). */
export function importVolumeRows(view: ImportVolumesView): Row[] {
  const gib = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(n / 1024 ** 2)} MiB`);
  return view.volumes.map((v) => ({
    itemRef: v.itemRef,
    name: v.resourceName ?? "",
    state: v.state,
    progress: v.rawBytesTotal ? `${Math.min(100, Math.floor((v.rawBytesDone / v.rawBytesTotal) * 100))}% (${gib(v.rawBytesDone)} of ${gib(v.rawBytesTotal)})` : v.rawBytesDone > 0 ? gib(v.rawBytesDone) : "",
    parts: v.partsDone,
    speed: v.bps ? `${gib(v.bps)}/s` : "",
    eta: v.etaSec != null ? `${Math.ceil(v.etaSec / 60)} min` : "",
    error: v.error ?? "",
  }));
}

export function register(program: Command): void {
  // ── fleet import follow-ups ──
  const imp = program.command("import").description("Fleet import (Coolify / Dokploy) follow-ups");
  imp
    .command("volumes <opId>")
    .description("Show the streamed volume copies of an import; abort or reset one (deploy scope for the actions)")
    .option("--abort <itemRef>", "stop the copy of this volume (the staged parts are kept)")
    .option("--reset <itemRef>", "discard this volume's staged parts and start it over")
    .option("--json", "output as JSON")
    .action(async (opId: string, opts: { abort?: string; reset?: string; json?: boolean }) => {
      if (opts.abort && opts.reset) throw new Error("use either --abort or --reset, not both");
      const { client } = activeClient();
      if (opts.abort || opts.reset) {
        const ref = (opts.abort ?? opts.reset) as string;
        const res = opts.abort ? await client.abortImportVolume(opId, ref) : await client.resetImportVolume(opId, ref);
        if (opts.json) printJson(res);
        else printLine(`${opts.abort ? "abort" : "reset"} requested for ${ref}: ${String((res as { state?: unknown }).state ?? "ok")}`);
        return;
      }
      const view = await client.getImportVolumes(opId);
      if (opts.json) {
        printJson(view);
        return;
      }
      if (!view.enabled) printLine("the streamed volume copy is switched off on this hub");
      else if (view.volumes.length === 0) printLine("no volume of this import has data to copy");
      else
        printTable(importVolumeRows(view), [
          { key: "itemRef", header: "VOLUME" },
          { key: "name", header: "NAME" },
          { key: "state", header: "STATE" },
          { key: "progress", header: "PROGRESS" },
          { key: "parts", header: "PARTS" },
          { key: "speed", header: "SPEED" },
          { key: "eta", header: "ETA" },
          { key: "error", header: "ERROR" },
        ]);
    });

  // ── servers ──
  const servers = program.command("servers").description("Manage servers");
  servers
    .command("ls")
    .description("List servers")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const rows = await activeClient().client.listServers();
      emit(rows, opts.json, [
        { key: "id", header: "ID" },
        { key: "name", header: "NAME" },
        { key: "status", header: "STATUS" },
        { key: "publicIp", header: "IP" },
        { key: "os", header: "OS" },
      ]);
    });

  servers
    .command("dns-credential <id> <credential>")
    .description("Use a team Cloudflare DNS credential as the server's DNS-01 resolver token (copied, encrypted; re-run after rotating it)")
    .option("--json", "output as JSON")
    .action(async (id: string, credential: string, opts: { json?: boolean }) => {
      const res = await activeClient().client.requestRaw("PUT", `/servers/${encodeURIComponent(id)}/network`, { dnsFromCredentialId: credential });
      if (opts.json) printJson(res ?? { ok: true });
      else printLine(`server ${id} now uses DNS credential ${credential} for DNS-01`);
    });

  // ── apps ──
  const apps = program.command("apps").description("Manage applications");
  apps
    .command("ls")
    .description("List applications")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const rows = await activeClient().client.listApps();
      emit(rows, opts.json, [
        { key: "id", header: "ID" },
        { key: "name", header: "NAME" },
        { key: "status", header: "STATUS" },
        { key: "source", header: "SOURCE" },
        { key: "domain", header: "DOMAIN" },
      ]);
    });
  apps
    .command("deploy <id>")
    .description("Trigger a deploy (needs a token with the deploy scope)")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const res = await activeClient().client.deployApp(id);
      if (opts.json) printJson(res);
      else printLine(`deploy triggered for app ${id}`);
    });
  apps
    .command("restart <id>")
    .description("Restart an application (deploy scope)")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const res = await activeClient().client.restartApp(id);
      if (opts.json) printJson(res);
      else printLine(`restart triggered for app ${id}`);
    });
  apps
    .command("domain <id> <domain>")
    .description("One-click Cloudflare DNS setup for a custom domain (deploy scope)")
    .option("--credential <id>", "DNS credential id (optional when the team has one Cloudflare credential)")
    .option("--no-www", "do not add a www record")
    .option("--overwrite", "replace existing records that point elsewhere")
    .option("--dry-run", "preview the records without writing them")
    .option("--json", "output as JSON")
    .action(
      async (
        id: string,
        domain: string,
        opts: { credential?: string; www?: boolean; overwrite?: boolean; dryRun?: boolean; json?: boolean },
      ) => {
        const res = await activeClient().client.autoSetupDomain(id, {
          domain,
          credentialId: opts.credential,
          includeWww: opts.www,
          overwrite: opts.overwrite,
          dryRun: opts.dryRun,
        });
        if (opts.json) printJson(res);
        else printLine(opts.dryRun ? `planned DNS records for ${domain}` : `DNS set up for ${domain}`);
      },
    );
  apps
    .command("logs <id>")
    .description("Fetch recent application logs")
    .option("--tail <n>", "number of lines", (v) => Number(v))
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { tail?: number; json?: boolean }) => {
      const logs = await activeClient().client.appLogs(id, opts.tail);
      if (opts.json) printJson(logs);
      else if (typeof logs === "string") printLine(logs);
      else printJson(logs);
    });

  apps
    .command("domain-options <id>")
    .description("Change domain options (currently: per-host DNS-01 certificates)")
    .requiredOption("--dns-challenge <on|off>", "issue the app's custom-domain certificate with DNS-01 per host")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { dnsChallenge: string; json?: boolean }) => {
      if (opts.dnsChallenge !== "on" && opts.dnsChallenge !== "off") throw new Error("--dns-challenge must be on or off");
      const res = await activeClient().client.requestRaw("PUT", `/apps/${encodeURIComponent(id)}/domain-options`, { dnsChallenge: opts.dnsChallenge === "on" });
      if (opts.json) printJson(res ?? { ok: true });
      else printLine(`DNS-01 per host ${opts.dnsChallenge} for app ${id}`);
    });

  // ── app container labels ──
  const labels = apps.command("labels").description("Container labels: what Tugra applies (read-only) and your custom ones");
  labels
    .command("ls <id>")
    .description("List the labels Tugra applies and the app's custom labels")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const view = await activeClient().client.getAppLabels(id);
      if (opts.json) {
        printJson(view);
        return;
      }
      const rows: Row[] = [
        ...view.tugra.map((l) => ({ source: "tugra", scope: l.scope, key: l.key, value: l.masked ? "(masked)" : (l.value ?? "") })),
        ...view.custom.map((l) => ({ source: "custom", scope: "container", key: l.key, value: l.value })),
        ...view.fromDockerOptions.map((l) => ({ source: "docker-options", scope: "container", key: l.key, value: l.value })),
      ];
      emit(rows, false, [
        { key: "source", header: "SOURCE" },
        { key: "scope", header: "SCOPE" },
        { key: "key", header: "KEY" },
        { key: "value", header: "VALUE" },
      ]);
    });
  labels
    .command("set <id> <pairs...>")
    .description("Set custom labels (KEY=VALUE ...). Merges over the current ones unless --replace. Applied on the next deploy")
    .option("--replace", "replace all custom labels instead of merging")
    .option("--json", "output as JSON")
    .action(async (id: string, pairs: string[], opts: { replace?: boolean; json?: boolean }) => {
      const wanted = parseLabelPairs(pairs);
      const client = activeClient().client;
      const current = opts.replace ? {} : Object.fromEntries((await client.getAppLabels(id)).custom.map((l) => [l.key, l.value]));
      const next = mergeLabels(current, wanted);
      const res = await client.setAppCustomLabels(id, next);
      if (opts.json) printJson(res);
      else printLine(`custom labels set on app ${id} (${Object.keys(next).length} total, applied on next deploy)`);
    });
  labels
    .command("rm <id> <keys...>")
    .description("Remove custom labels by key. Applied on the next deploy")
    .option("--json", "output as JSON")
    .action(async (id: string, keys: string[], opts: { json?: boolean }) => {
      const client = activeClient().client;
      const current = (await client.getAppLabels(id)).custom;
      const drop = new Set(keys.map((k) => k.toLowerCase()));
      const missing = keys.filter((k) => !current.some((l) => l.key.toLowerCase() === k.toLowerCase()));
      if (missing.length) throw new Error(`no custom label named ${missing.map((k) => JSON.stringify(k)).join(", ")}`);
      const next = Object.fromEntries(current.filter((l) => !drop.has(l.key.toLowerCase())).map((l) => [l.key, l.value]));
      const res = await client.setAppCustomLabels(id, next);
      if (opts.json) printJson(res);
      else printLine(`removed ${keys.length} custom label(s) from app ${id} (applied on next deploy)`);
    });
  labels
    .command("reset <id>")
    .description("Remove ALL custom labels (Tugra's own labels are derived on every deploy). Applied on the next deploy")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const res = await activeClient().client.setAppCustomLabels(id, {});
      if (opts.json) printJson(res);
      else printLine(`custom labels reset on app ${id} (applied on next deploy)`);
    });

  // ── databases ──
  const db = program.command("db").description("Manage databases");
  db
    .command("ls")
    .description("List databases")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const rows = await activeClient().client.listDatabases();
      emit(rows, opts.json, [
        { key: "id", header: "ID" },
        { key: "name", header: "NAME" },
        { key: "engine", header: "ENGINE" },
        { key: "status", header: "STATUS" },
        { key: "serverId", header: "SERVER" },
      ]);
    });

  // ── backups ──
  const backup = program.command("backup").description("Manage database backups");
  backup
    .command("run <dbId>")
    .description("Take a backup of a database now")
    .option("--json", "output as JSON")
    .action(async (dbId: string, opts: { json?: boolean }) => {
      const res = await activeClient().client.backupNow(dbId);
      if (opts.json) printJson(res);
      else emit([res], false, [
        { key: "id", header: "ID" },
        { key: "status", header: "STATUS" },
        { key: "filename", header: "FILENAME" },
        { key: "sizeBytes", header: "SIZE" },
        { key: "createdAt", header: "CREATED" },
      ]);
    });
}
