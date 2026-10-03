import type { Command } from "commander";
import { activeClient } from "../session";
import { printJson, printLine, printTable } from "../output";
import type { Column } from "../output";
import type { Row } from "../client";

function emit(rows: Row[], json: boolean | undefined, columns: Column[]): void {
  if (json) printJson(rows);
  else printTable(rows, columns);
}

export function register(program: Command): void {
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
