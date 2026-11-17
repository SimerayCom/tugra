import * as readline from "node:readline";
import type { Command } from "commander";
import { activeClient } from "../session";
import { formatTable, printJson, printLine } from "../output";
import type { OobActionShape, OobCandidateShape, OobPowerAction, OobStatusShape, TugraClient } from "../client";

/** The word a person types for each power action. `reboot` is a HARD reset (power cut and started again). */
const POWER_WORDS: Record<string, OobPowerAction> = {
  on: "power_on",
  off: "power_off",
  reboot: "reboot",
  shutdown: "shutdown",
  power_on: "power_on",
  power_off: "power_off",
};
const DESTRUCTIVE: ReadonlySet<OobPowerAction> = new Set(["power_off", "reboot", "shutdown"]);

export function parsePowerAction(word: string): OobPowerAction {
  const a = POWER_WORDS[word.trim().toLowerCase()];
  if (!a) throw new Error(`unknown power action ${JSON.stringify(word)}: use on, off (hard), reboot (hard reset) or shutdown (graceful)`);
  return a;
}

export interface OobDeps {
  client: Pick<TugraClient, "getServer" | "oobPower">;
  /** Ask the person to type something; only used when --yes is absent. */
  ask: (question: string) => Promise<string>;
  interactive: boolean;
}

/**
 * Power a cloud-linked server at the provider (works with the agent offline). off / reboot / shutdown take everything on
 * the server down, so — like `servers reboot` — the person types the server's name, or passes `--yes` (the explicit "I
 * mean this server"). Without `--yes` and without a terminal it refuses rather than acting. Nothing is sent before then.
 */
export async function runOobPower(deps: OobDeps, id: string, word: string, opts: { yes?: boolean }): Promise<OobActionShape> {
  const action = parsePowerAction(word);
  if (!DESTRUCTIVE.has(action)) return deps.client.oobPower(id, { action });
  const server = await deps.client.getServer(id);
  const name = String(server.name ?? "");
  if (!name) throw new Error("the hub did not return the server's name");
  if (!opts.yes) {
    if (!deps.interactive) throw new Error(`refusing to ${word} without confirmation: run this in a terminal, or pass --yes`);
    const what = action === "reboot" ? "a hard reset" : action === "power_off" ? "a hard power off" : "a shutdown";
    const typed = (await deps.ask(`Type the server name (${name}) to confirm ${what}: `)).trim();
    if (typed !== name) throw new Error("confirmation did not match the server name — nothing was sent");
  }
  return deps.client.oobPower(id, { action, confirmName: name });
}

/** `oob-status` as text (pure). */
export function formatOobStatus(s: OobStatusShape): string[] {
  if (!s.linked) {
    if (s.credentialMissing) return ["linked to a cloud server, but its credential was deleted: link it again (tugra servers oob-link)"];
    return ["not linked to a cloud server (tugra servers oob-link <id> --credential <credentialId> to list the candidates)"];
  }
  const out = [`provider: ${s.provider}${s.manual ? " (linked by hand)" : " (provisioned by Tugra)"}  credential: ${s.credentialName ?? "?"}`];
  if (!s.supported) out.push("out-of-band actions are not available for this provider yet");
  if (s.state) {
    out.push(`cloud server: ${s.state.name} (#${s.state.providerServerId})  power: ${s.state.status}${s.state.locked ? "  LOCKED by the provider" : ""}`);
    out.push(`rescue mode: ${s.state.rescueEnabled ? "armed (boots into rescue on the next boot)" : "off"}`);
    if (s.state.publicIpv4) out.push(`public IPv4: ${s.state.publicIpv4}`);
  }
  if (s.stateError) out.push(`could not read the cloud server: ${s.stateError}`);
  return out;
}

export function formatCandidates(rows: OobCandidateShape[]): string {
  return formatTable(
    rows.map((r) => ({ ...r, ip: r.publicIpv4 ?? "", match: r.matchesIp ? "yes" : "", linked: r.taken ? "taken" : "" })),
    [
      { key: "providerServerId", header: "ID" },
      { key: "name", header: "NAME" },
      { key: "status", header: "STATUS" },
      { key: "ip", header: "IPV4" },
      { key: "match", header: "THIS SERVER" },
      { key: "linked", header: "" },
    ],
  );
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
    .command("oob-status <id>")
    .description("Show a server's cloud link and the provider-side power / rescue state (works with the agent offline)")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const s = await activeClient().client.getServerOob(id);
      if (opts.json) printJson(s);
      else for (const l of formatOobStatus(s)) printLine(l);
    });

  servers
    .command("oob-power <id> <action>")
    .description("Power a cloud-linked server at the provider: on | off (hard) | reboot (hard reset) | shutdown (graceful). off/reboot/shutdown ask you to type the server name unless --yes (deploy scope)")
    .option("--yes", "confirm without being asked (you mean this server)")
    .option("--json", "output as JSON")
    .action(async (id: string, action: string, opts: { yes?: boolean; json?: boolean }) => {
      const { client } = activeClient();
      const res = await runOobPower({ client, ask, interactive: !!process.stdin.isTTY }, id, action, opts);
      if (opts.json) printJson(res);
      else printLine(`${res.action} sent to the cloud provider (${res.providerAction.command}, ${res.providerAction.status}) — check it with: tugra servers oob-status ${id}`);
    });

  servers
    .command("oob-rescue <id> <enable|disable>")
    .description("Enable or disable the provider's rescue system. Enabling prints the one-time root password ONCE (it is never stored); then reboot the server (deploy + read:secrets scopes to enable)")
    .option("--json", "output as JSON")
    .action(async (id: string, what: string, opts: { json?: boolean }) => {
      const { client } = activeClient();
      if (what === "disable") {
        const res = await client.oobDisableRescue(id);
        if (opts.json) printJson(res);
        else printLine("rescue mode disabled — the server boots from its own disk on the next boot");
        return;
      }
      if (what !== "enable") throw new Error(`use "enable" or "disable", not ${JSON.stringify(what)}`);
      const res = await client.oobEnableRescue(id);
      if (opts.json) {
        printJson(res);
        return;
      }
      printLine(`rescue mode armed. Root password (shown once, copy it now): ${res.rootPassword}`);
      printLine(`It boots into rescue on the next (re)boot and turns itself off after that boot or after ${res.expiresInMinutes} minutes.`);
      printLine(`Reboot it with: tugra servers oob-power ${id} reboot`);
    });

  servers
    .command("oob-console <id>")
    .description("Request a provider console session: prints the websocket URL and VNC password ONCE (valid about a minute; never stored). deploy + read:secrets scopes")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const res = await activeClient().client.oobConsole(id);
      if (opts.json) {
        printJson(res);
        return;
      }
      printLine(`console url (valid ${res.validForSeconds} s): ${res.wssUrl}`);
      printLine(`vnc password (shown once): ${res.password}`);
    });

  servers
    .command("oob-link <id>")
    .description("Link an existing server to its cloud server. With only --credential it lists that credential's cloud servers; add --cloud-server to link (servers:manage)")
    .requiredOption("--credential <id>", "the cloud provider credential (see Cloud providers in the panel)")
    .option("--cloud-server <id>", "the provider's server id to link")
    .option("--confirm-name <name>", "the cloud server's name, needed when its public IP cannot be matched to this server's")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { credential: string; cloudServer?: string; confirmName?: string; json?: boolean }) => {
      const { client } = activeClient();
      if (!opts.cloudServer) {
        const rows = await client.oobCandidates(id, opts.credential);
        if (opts.json) printJson(rows);
        else printLine(formatCandidates(rows));
        return;
      }
      const res = await client.oobLink(id, {
        cloudCredentialId: opts.credential,
        providerServerId: opts.cloudServer,
        ...(opts.confirmName ? { confirmProviderName: opts.confirmName } : {}),
      });
      if (opts.json) printJson(res);
      else for (const l of formatOobStatus(res)) printLine(l);
    });

  servers
    .command("oob-unlink <id>")
    .description("Remove a hand-made cloud link (a link Tugra made when it provisioned the server stays; servers:manage)")
    .option("--json", "output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const res = await activeClient().client.oobUnlink(id);
      if (opts.json) printJson(res);
      else printLine(`server ${id} is no longer linked to a cloud server`);
    });
}
