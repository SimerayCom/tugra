import type { AgentPlanAdditions, CoolifySecretClass } from "@tugra/shared";
import { ForbiddenException } from "@nestjs/common";
import type { ForeignApp, ForeignFleet, ServiceBundle } from "../foreign-fleet";
import type { FetchedSecrets, ImportSourceCapabilities, SourceAppExtras } from "../import-source";
import type { RawSettings, SettingsSection } from "../settings/settings-types";
import { CoolifySource } from "./coolify.source";
import { AgentSensitiveClient, type AgentCoolifyClient } from "./agent-coolify.client";
import { NO_OVERLAY, type AgentSecretStore, type SecretOverlay } from "./agent-secrets";

/** The classes an apply reads: environment values, shared variables (they expand into env values), compose/Dockerfile/label/config text and engine config. */
const APPLY_CLASSES: readonly CoolifySecretClass[] = ["env", "shared_env", "service_compose", "db_credentials"];
/** The classes the settings import reads. `notification` is opt-in and is simply absent when the owner did not consent to it. */
const SETTINGS_CLASSES: Record<SettingsSection, readonly CoolifySecretClass[]> = {
  notifications: ["notification"],
  sharedVariables: ["shared_env"],
  storages: [],
  scheduledTasks: ["task_command"],
  serverSettings: [],
  tags: [],
  members: [],
};
const PLAN_TEXT = new Set(["docker_compose_raw"]);

/**
 * The Coolify source read through the agent on the Coolify host. It is the API-token source with a different client, so the fleet,
 * the plan and the plan hash come out of the very same code. It adds the facts only the agent read knows (the Coolify team of each
 * project, the schema version, secret counts) as the plan's additive, hash-excluded block.
 *
 * With a secret store (the import session's own run) it is also as complete as the token path at apply time: every method that a
 * `read:sensitive` token answers (env values, service variables and files, Dockerfile, labels, engine config, settings) is answered
 * from a second view of the same snapshot whose values are the opened secrets. A value the agent could not open is absent, so the
 * item that needs it is the item held back by the same checks the token path has.
 */
export class AgentCoolifySource extends CoolifySource {
  private readonly sensitive: CoolifySource;
  private readonly overlay: SecretOverlay;

  constructor(
    private readonly agentClient: AgentCoolifyClient,
    private readonly store?: AgentSecretStore,
  ) {
    super(agentClient);
    this.overlay = store ?? NO_OVERLAY;
    this.sensitive = new CoolifySource(new AgentSensitiveClient(agentClient, this.overlay));
    if (store) agentClient.planOverlay = store.onlyFields(PLAN_TEXT);
  }

  override capabilities(): ImportSourceCapabilities {
    return { apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false };
  }

  /** Reachable = the agent answered and the read confirmed a read-only, REPEATABLE READ session. */
  override async verify(): Promise<{ ok: boolean; version?: string; detail?: string }> {
    try {
      const view = await this.agentClient.agentView();
      const version = view.versionText();
      return version ? { ok: true, version } : { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "verification failed" };
    }
  }

  override async discover(): Promise<ForeignFleet> {
    // The compose text of apps and services is part of what the plan needs: read when the owner consented (otherwise the plan says so).
    await this.ensure(["service_compose"]);
    const [fleet, view, valuesAllowed] = await Promise.all([super.discover(), this.agentClient.agentView(), this.envValuesAllowed()]);
    return {
      ...fleet,
      apps: fleet.apps.map((a) => withAgentEnvReport(a, valuesAllowed)),
      warnings: [...fleet.warnings.map(agentWarning), ...view.warnings],
      ...(fleet.scopedWarnings ? { scopedWarnings: fleet.scopedWarnings.map((w) => ({ ...w, text: agentWarning(w.text) })) } : {}),
    };
  }

  /** Does the owner's consent for THIS import session cover the variable values? A cheap grant lookup, nothing is read. */
  private async envValuesAllowed(): Promise<boolean> {
    return this.store ? (await this.store.consentedClasses()).includes("env") : false;
  }

  /** The block the plan carries on top of the API-path plan. */
  async agentPlan(): Promise<AgentPlanAdditions> {
    const view = await this.agentClient.agentView();
    const unreadable = this.store?.unreadable() ?? [];
    const consented = this.store ? await this.store.consentedClasses() : [];
    return {
      agentRead: view.meta,
      ...(view.teams.length ? { teams: view.teams } : {}),
      ...(unreadable.length ? { unreadable } : {}),
      // Classes only: whether the owner's consent for THIS session stands, so the screen can say so after a reload.
      ...(consented.length ? { secretsConsent: { classes: consented } } : {}),
    };
  }

  /** The Coolify servers of the read with their addresses (the same facts the host match needs): one cheap read, no secret. */
  async sourceServers(): Promise<Array<{ ref: string; address: string | null; controlPlane: boolean }>> {
    const rows = await this.agentClient.get<Array<{ uuid?: unknown; ip?: unknown; is_coolify_host?: unknown }>>("/servers");
    return rows.flatMap((r) => (typeof r.uuid === "string" ? [{ ref: r.uuid, address: typeof r.ip === "string" ? r.ip : null, controlPlane: r.is_coolify_host === true }] : []));
  }

  override async currentTeam(): Promise<string | undefined> {
    return (await this.agentClient.agentView()).currentTeam?.name;
  }

  /**
   * The apply is about to start: the owner's consent for THIS import session must be standing, or nothing is created. Reads again from
   * scratch (the plan's values are not reused for an apply).
   */
  async beginApply(): Promise<void> {
    if (!this.store) throw consentRequired();
    if ((await this.store.consentedClasses()).length === 0) throw consentRequired();
    this.store.reset();
  }

  /** The apply is over: forget what was read and end the owner's consent for this session. */
  async finishApply(): Promise<void> {
    await this.store?.finish();
  }

  // ── the sensitive reads, from the opened values ──────────────────────────────────────────────────

  override async fetchSecrets(ref: string): Promise<FetchedSecrets> {
    await this.ensure(APPLY_CLASSES);
    return this.sensitive.fetchSecrets(ref);
  }

  override async fetchServiceBundle(ref: string): Promise<ServiceBundle | undefined> {
    await this.ensure(APPLY_CLASSES);
    return this.sensitive.fetchServiceBundle(ref);
  }

  override async fetchDbConfigFile(ref: string, engine?: string): Promise<string | undefined> {
    await this.ensure(APPLY_CLASSES);
    return this.sensitive.fetchDbConfigFile(ref, engine);
  }

  override async fetchAppExtras(ref: string): Promise<SourceAppExtras | undefined> {
    await this.ensure(APPLY_CLASSES);
    return this.sensitive.fetchAppExtras(ref);
  }

  override async readSettings(only?: ReadonlySet<SettingsSection>): Promise<RawSettings> {
    const wanted = new Set<CoolifySecretClass>();
    for (const [section, classes] of Object.entries(SETTINGS_CLASSES) as Array<[SettingsSection, readonly CoolifySecretClass[]]>) {
      if (!only || only.has(section)) for (const c of classes) wanted.add(c);
    }
    const outcome = await this.ensure([...wanted]);
    const raw = await this.sensitive.readSettings(only);
    // Without the consent a task's command is unknown: the section is refused, never half-read with empty commands.
    if (wanted.has("task_command") && outcome.task_command !== "loaded" && raw.scheduledTasks.ok) {
      return { ...raw, scheduledTasks: { ok: false, reason: "forbidden" } };
    }
    return raw;
  }

  private async ensure(classes: readonly CoolifySecretClass[]): Promise<Record<string, string>> {
    if (!this.store || classes.length === 0) return {};
    const view = await this.agentClient.agentView();
    return this.store.ensure(classes, () => view.secretRefs());
  }
}

/**
 * The base discover reads every app's variables through the plain client, which never carries a value (like a token without
 * `read:sensitive`), so its report calls every app "the API token cannot read values". That is the wrong diagnosis on this path, which has
 * no token, and values are not part of the plan (they are read at apply time, from the owner's consent, one session read).
 *  - Consent for the values stands: they WILL be carried. Only what is known without a value stays unresolved (LOCKED and Coolify's own
 *    magic variables); "no value in the plan" is not a missing value. A value the apply cannot open is held back per key by the apply's checks.
 *  - No consent: the report says the consent is what is missing (`awaitingConsent`), not a token.
 */
function withAgentEnvReport(app: ForeignApp, valuesAllowed: boolean): ForeignApp {
  const r = app.envReport;
  if (!r || !r.tokenReadOnly) return app;
  if (!valuesAllowed) return { ...app, envReport: { ...r, tokenReadOnly: false, awaitingConsent: true } };
  return { ...app, envReport: { ...r, tokenReadOnly: false, unresolved: r.unresolved.filter((u) => u.reason === "LOCKED" || u.reason === "MAGIC") } };
}

function consentRequired(): ForbiddenException {
  return new ForbiddenException({ statusCode: 403, code: "consent_required", message: "allow reading secret values for this import first" });
}

/** A token path tells the user to use a `read:sensitive` token; on the agent path the same text is read by the sealed secret step. */
function agentWarning(w: string): string {
  return w.replace(/needs a read:sensitive token to fetch its compose file before import/, "has its compose file read by the sealed secret step (not read yet)");
}
