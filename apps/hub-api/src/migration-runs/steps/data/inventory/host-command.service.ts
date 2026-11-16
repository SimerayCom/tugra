import { Inject, Injectable } from "@nestjs/common";
import { buildMigrationCommand } from "../../../../importer/migration-command";
import { hostLoopOf, type RunSnapshot, type StepKey } from "../../../core/run-contract";
import { DATA_PORT, type DataPort, type DataSnapshot } from "../data-contract";
import { migratorFlags, type MigratorPhase } from "../data-logic";
import { phaseFor } from "../run-commands";
import { buildStopList, UNRESOLVED_CHECK } from "../freeze.handler";
import { buildHostLoopScript, onlyFlags, wrapHostLoopCommand, type LoopHostInput, type LoopScriptStep } from "../source-control/host-loop-script";
import { HostCommandError, type HostCommandInput, type RunHostCommandPort } from "./inventory-contract";
import { dataItemsOfHost, serverRefOfItem, sourceHostsOf } from "./host-hosts";

/**
 * Builds the commands the run facade mints for `kind: host-loop | inventory` (`POST /steps/:key/command`): the one script that
 * loops over the run's source hosts from the Coolify host, or the read-only inventory/probe command. The migration token is
 * minted by the facade (it is the importer's own op token); this service only embeds it, once, into the text it returns.
 */
@Injectable()
export class HostCommandService implements RunHostCommandPort {
  constructor(@Inject(DATA_PORT) private readonly data: DataPort) {}

  async build(input: HostCommandInput): Promise<{ command: string; hosts: string[] }> {
    const run = input.run;
    if (!run.opId) throw new HostCommandError("step-unsupported");
    const snap = await this.data.snapshot(run);
    try {
      if (input.kind === "inventory" && run.options.sourceRunner !== "coolify-host-loop") {
        // a single host: the same bootstrap the operator already uses, in inventory mode (add --server-ref <uuid> to label the host)
        return { command: `${buildMigrationCommand(input.token, input.hubBase)} --inventory`, hosts: [] };
      }
      return this.loop(input, run, snap);
    } catch (e) {
      if (e instanceof HostCommandError) throw e;
      throw new HostCommandError("unsafe-input"); // the builders refuse (plain Error) any value that is not safe to embed
    }
  }

  private loop(input: HostCommandInput, run: RunSnapshot, snap: DataSnapshot): { command: string; hosts: string[] } {
    const opt = hostLoopOf(run.options);
    const step: LoopScriptStep = input.kind === "inventory" ? "INVENTORY" : (input.step as StepKey) === "FREEZE" ? "FREEZE" : input.step === "DATA_FINAL" ? "DATA_FINAL" : "DATA_SEED";
    if (input.kind === "host-loop" && !["DATA_SEED", "DATA_FINAL", "FREEZE"].includes(input.step)) throw new HostCommandError("step-unsupported");

    let phase: MigratorPhase | undefined;
    if (step === "DATA_SEED" || step === "DATA_FINAL") phase = phaseFor(step, run, snap) ?? undefined;
    const hosts: LoopHostInput[] = [];
    const all = sourceHostsOf(run, snap);
    for (const ref of all) {
      if (step === "INVENTORY") {
        hosts.push({ ref, flags: [], freezeItems: [] });
      } else if (step === "FREEZE") {
        const items = buildStopList(snap)
          .filter((s) => serverRefOfItem(s.itemRef) === ref)
          .map((s) => s.itemRef);
        if (items.length) hosts.push({ ref, flags: [], freezeItems: items });
      } else {
        const items = dataItemsOfHost(ref, snap);
        if (items.length) hosts.push({ ref, flags: [...migratorFlags(phase as MigratorPhase, run, snap), ...onlyFlags(items)], freezeItems: [] });
      }
    }
    if (hosts.length === 0) throw new HostCommandError("no-hosts");
    const script = buildHostLoopScript({
      runId: run.id,
      step,
      phase,
      hubBase: input.hubBase,
      token: input.token,
      hosts,
      keyDir: opt.keyDir,
      parallel: opt.parallel,
      connectTimeoutSec: opt.connectTimeoutSec,
      retries: opt.retries,
      allowUnresolved: input.attested.includes(UNRESOLVED_CHECK),
    });
    return { command: wrapHostLoopCommand(script), hosts: hosts.map((h) => h.ref) };
  }
}
