import { Inject, Injectable } from "@nestjs/common";
import { buildMigrationCommand } from "../../../../importer/migration-command";
import { hostLoopOf, type RunSnapshot, type StepKey } from "../../../core/run-contract";
import { DATA_PORT, type DataPort, type DataSnapshot } from "../data-contract";
import { migratorFlags, type MigratorPhase } from "../data-logic";
import { phaseFor } from "../run-commands";
import { buildStopList, UNRESOLVED_CHECK } from "../freeze.handler";
import { freezeItemOf } from "../source-control/host-freeze-script";
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
    if (input.token === null) return this.unfreeze(input);
    if (!run.opId) throw new HostCommandError("step-unsupported");
    const snap = await this.data.snapshot(run);
    const token = input.token;
    try {
      if (input.kind === "inventory" && run.options.sourceRunner !== "coolify-host-loop") {
        // a single host: the same bootstrap the operator already uses, in inventory mode (add --server-ref <uuid> to label the host)
        return { command: `${buildMigrationCommand(input.token, input.hubBase)} --inventory`, hosts: [] };
      }
      return this.loop({ ...input, token }, run, snap);
    } catch (e) {
      if (e instanceof HostCommandError) throw e;
      throw new HostCommandError("unsafe-input"); // the builders refuse (plain Error) any value that is not safe to embed
    }
  }

  private loop(input: HostCommandInput & { token: string }, run: RunSnapshot, snap: DataSnapshot): { command: string; hosts: string[] } {
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
          .map((s) => freezeItemOf(s));
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

  /**
   * The TOKENLESS FREEZE rollback: it starts again exactly the containers each host recorded when it stopped them. The hosts are the
   * ones the run's FREEZE compensation record names (the run may be aborted, its plan unreadable, its token revoked: none of that may
   * stand between the operator and their stopped writers), so this path reads nothing from the hub's data port.
   */
  private unfreeze(input: HostCommandInput): { command: string; hosts: string[] } {
    const run = input.run;
    const opt = hostLoopOf(run.options);
    if (input.step !== "FREEZE" || input.kind !== "host-loop") throw new HostCommandError("step-unsupported");
    const refs = [...new Set(input.unfreezeHosts ?? [])].sort();
    if (refs.length === 0) throw new HostCommandError("no-hosts");
    try {
      const script = buildHostLoopScript({
        runId: run.id,
        step: "FREEZE",
        hubBase: input.hubBase,
        token: null,
        hosts: refs.map((ref) => ({ ref, flags: [], freezeItems: [] })),
        keyDir: opt.keyDir,
        parallel: opt.parallel,
        connectTimeoutSec: opt.connectTimeoutSec,
        retries: opt.retries,
      });
      return { command: wrapHostLoopCommand(script), hosts: refs };
    } catch {
      throw new HostCommandError("unsafe-input");
    }
  }
}
