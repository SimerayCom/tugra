import * as readline from "node:readline";
import type { Command } from "commander";
import { setProfile, removeProfile, loadConfig, setCurrent, getActiveProfile } from "../config";
import { TugraClient } from "../client";
import { normalizeHub, maskToken } from "../session";
import { printJson, printLine, printTable } from "../output";

/**
 * Validate a PAT against the hub, then persist it as a profile. Returns the profile name + hub. Pure enough
 * to unit-test: pass a `makeClient` that injects a stub fetch, and a `save`.
 */
export async function doLogin(
  input: { hub: string; token: string; profile: string },
  deps: { makeClient?: (o: { hub: string; token: string }) => TugraClient; save?: typeof setProfile } = {},
): Promise<{ profile: string; hub: string }> {
  const hub = normalizeHub(input.hub);
  const token = input.token.trim();
  if (!token.startsWith("tugra_pat_")) {
    throw new Error("that doesn't look like a Tugra token (expected a tugra_pat_… personal access token)");
  }
  const makeClient = deps.makeClient ?? ((o) => new TugraClient(o));
  const save = deps.save ?? setProfile;
  // Probe a known list endpoint: a 200 that isn't a JSON array means --hub points at something that isn't a
  // Tugra API — reject now rather than saving a profile that makes every later command crash opaquely.
  const probe = await makeClient({ hub, token }).listServers(); // ApiError (401/403) surfaces the reason verbatim
  if (!Array.isArray(probe)) throw new Error(`${hub} doesn't look like a Tugra hub (unexpected response)`);
  save(input.profile, { hub, token });
  return { profile: input.profile, hub };
}

/** Read a token from stdin without echoing it (so a pasted secret never lands on screen / in scrollback). */
function promptToken(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write("Paste your personal access token: ");
    // Suppress echo of the typed/pasted characters.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

export function register(program: Command): void {
  program
    .command("login")
    .description("Store a personal access token for a hub (mint the token in the web UI first)")
    .requiredOption("--hub <url>", "hub base URL, e.g. https://tugra.example.com")
    .option("--token <token>", "personal access token (otherwise read from $TUGRA_TOKEN or prompted)")
    .option("--profile <name>", "profile name", "default")
    .action(async (opts: { hub: string; token?: string; profile: string }) => {
      const token = opts.token || process.env.TUGRA_TOKEN || (await promptToken());
      const { profile, hub } = await doLogin({ hub: opts.hub, token, profile: opts.profile });
      printLine(`logged in to ${hub} as profile "${profile}"`);
    });

  program
    .command("logout")
    .description("Forget a stored profile's token locally")
    .option("--profile <name>", "profile to remove (default: the active one)")
    .action((opts: { profile?: string }) => {
      const name = opts.profile ?? getActiveProfile()?.name;
      if (!name) throw new Error("no active profile to log out of");
      if (!removeProfile(name)) throw new Error(`no such profile: ${name}`);
      printLine(`removed local profile "${name}".`);
      printLine(
        "note: this only forgets the token locally — it does NOT revoke it. To revoke, delete the token in the web UI (Settings → API tokens).",
      );
    });

  program
    .command("ctx")
    .description("Show profiles, or `ctx use <name>` to switch the active one")
    .argument("[action]", "'use' to switch")
    .argument("[name]", "profile name (with 'use')")
    .option("--json", "output as JSON")
    .action((action: string | undefined, name: string | undefined, opts: { json?: boolean }) => {
      if (action === "use") {
        if (!name) throw new Error("usage: tugra ctx use <name>");
        setCurrent(name);
        printLine(`switched to profile "${name}"`);
        return;
      }
      const cfg = loadConfig();
      const rows = Object.entries(cfg.profiles).map(([n, p]) => ({
        active: n === cfg.current ? "*" : "",
        name: n,
        hub: p.hub,
        token: maskToken(p.token),
      }));
      if (opts.json) {
        printJson(rows);
        return;
      }
      if (rows.length === 0) {
        printLine("no profiles — run `tugra login --hub <url>`");
        return;
      }
      printTable(rows, [
        { key: "active", header: "" },
        { key: "name", header: "PROFILE" },
        { key: "hub", header: "HUB" },
        { key: "token", header: "TOKEN" },
      ]);
    });
}
