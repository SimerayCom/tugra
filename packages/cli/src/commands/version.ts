import type { Command } from "commander";
import { CLI_VERSION, EXPECTED_PROTOCOL } from "../version";
import { getActiveProfile } from "../config";
import { TugraClient, type HubVersion } from "../client";
import { printJson, printLine } from "../output";

export function register(program: Command): void {
  program
    .command("version")
    .description("Show the CLI version, the hub version, and warn on a protocol skew")
    .option("--json", "output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const active = getActiveProfile();
      let hub: HubVersion | null = null;
      let hubError: string | null = null;
      if (active) {
        try {
          hub = await new TugraClient(active.profile).getVersion();
        } catch (e) {
          hubError = e instanceof Error ? e.message : String(e);
        }
      }

      if (opts.json) {
        printJson({ cli: CLI_VERSION, expectedProtocol: EXPECTED_PROTOCOL, hub, hubError });
        return;
      }

      printLine(`tugra CLI ${CLI_VERSION}`);
      if (hub) {
        printLine(`hub ${hub.version} (edition ${hub.edition}, channel ${hub.channel}, protocol ${hub.protocol})`);
        if (hub.protocol !== EXPECTED_PROTOCOL) {
          process.stderr.write(
            `warning: hub protocol ${hub.protocol} differs from this CLI's ${EXPECTED_PROTOCOL} — ` +
              "some commands may not work; update the CLI or hub.\n",
          );
        }
      } else if (active) {
        printLine(`hub: unreachable (${hubError})`);
      } else {
        printLine("hub: not logged in (run `tugra login --hub <url>`)");
      }
    });
}
