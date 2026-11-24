/**
 * Pure: turn a {@link RawSettings} read plus what the target team already has into (a) the secret-free preview the
 * review screen shows and (b) the in-memory plan the apply uses. ONE builder feeds both, so what the owner reviewed is
 * exactly what the apply can do (an entry id the preview did not offer, or offered as blocked, is never applied).
 */
import { isValidEnvKey, isSafeEnvValue } from "../../common/env-key";
import { normalizeTags } from "../../common/tags";
import {
  COOLIFY_EVENT_MAP,
  channelName,
  cronFromFrequency,
  planChannelGroups,
  suggestedRole,
  unmappedEvents,
} from "./coolify-settings-map";
import {
  SETTINGS_SECTIONS,
  type ChannelGroup,
  type RawChannel,
  type RawMember,
  type RawServerCleanup,
  type RawSettings,
  type RawSharedVar,
  type RawStorage,
  type RawTag,
  type RawTask,
  type SettingsEntry,
  type SettingsNote,
  type SettingsSection,
  type SettingsSectionPreview,
  type TargetContext,
} from "./settings-types";

/** What the apply needs for one entry (SECRET-BEARING for some variants: it never leaves the hub). */
export type PlannedEntry =
  | { section: "notifications"; channel: RawChannel; groups: ChannelGroup[] }
  | { section: "sharedVariables"; variable: RawSharedVar }
  | { section: "storages"; storage: RawStorage }
  | { section: "scheduledTasks"; task: RawTask; cron: string; appId: string }
  | { section: "serverSettings"; cleanup: RawServerCleanup; cron: string }
  | { section: "tags"; tag: RawTag; targets: Array<{ kind: "application" | "database"; id: string }>; tugraName: string }
  | { section: "members"; member: RawMember };

export interface SettingsPlan {
  sections: SettingsSectionPreview[];
  planned: Map<string, PlannedEntry>;
}

const BUCKET_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const TASK_NAME_MAX = 80;

/** `endpoint|bucket`, lower-cased with no trailing slash: how a storage and a destination are compared. */
export const destinationKey = (endpoint: string, bucket: string): string => `${endpoint.trim().toLowerCase().replace(/\/+$/, "")}|${bucket.trim().toLowerCase()}`;

/** `appId|name|command`: how a carried task is recognised on a second run. */
export const taskKey = (appId: string, name: string, command: string): string => `${appId}|${name}|${command}`;

const note = (level: SettingsNote["level"], code: string, params?: SettingsNote["params"]): SettingsNote => ({ level, code, ...(params ? { params } : {}) });

function entry(e: Omit<SettingsEntry, "selectable" | "blocked" | "defaultSelected"> & { blocked?: string; defaultSelected: boolean }): SettingsEntry {
  const { blocked, defaultSelected, ...rest } = e;
  return blocked ? { ...rest, selectable: false, defaultSelected: false, blocked } : { ...rest, selectable: true, defaultSelected };
}

export function buildSettingsPlan(raw: RawSettings, ctx: TargetContext): SettingsPlan {
  const planned = new Map<string, PlannedEntry>();
  const sections: SettingsSectionPreview[] = SETTINGS_SECTIONS.map((section) => {
    const read = raw[section];
    if (!read.ok) return { section, available: false, reason: read.reason, entries: [] };
    const entries = BUILD[section](raw, ctx, planned);
    return { section, available: true, ...(read.partial ? { partial: true } : {}), entries };
  });
  return { sections, planned };
}

type Builder = (raw: RawSettings, ctx: TargetContext, planned: Map<string, PlannedEntry>) => SettingsEntry[];

const notifications: Builder = (raw, ctx, planned) => {
  if (!raw.notifications.ok) return [];
  return raw.notifications.items.map((ch) => {
    const id = `notification:${ch.kind}`;
    const groups = planChannelGroups(ch);
    const names = groups.map((g) => channelName(ch.kind, g));
    const notes: SettingsNote[] = [];
    const unmapped = unmappedEvents(ch);
    if (unmapped.length) notes.push(note("warn", "events_not_carried", { events: unmapped.join(", ") }));
    if (groups.length > 1) notes.push(note("info", "topics_split", { n: groups.length }));
    if (!ch.enabled) notes.push(note("info", "source_disabled"));
    const blocked = ch.instanceEmail ? "email_instance_settings" : !ch.secretsReadable ? "needs_sensitive" : names.every((n) => ctx.channelNames.has(n)) ? "exists" : undefined;
    if (!blocked) {
      notes.push(note("info", "double_send"));
      planned.set(id, { section: "notifications", channel: ch, groups });
    }
    return entry({
      id,
      section: "notifications",
      name: ch.kind,
      blocked,
      defaultSelected: ch.enabled,
      notes,
      detail: {
        kind: ch.kind,
        enabled: ch.enabled,
        groups: groups.map((g) => ({ ...(g.threadId ? { threadId: g.threadId } : {}), coolifyEvents: g.coolifyEvents, tugraEvents: g.tugraEvents, events: g.coolifyEvents.map((from) => ({ from, to: [...(COOLIFY_EVENT_MAP[from] ?? [])] })) })),
        targetNames: names,
      },
    });
  });
};

const SCOPE_ORDER: Record<RawSharedVar["scope"], number> = { team: 0, project: 1, environment: 2 };

const sharedVariables: Builder = (raw, ctx, planned) => {
  if (!raw.sharedVariables.ok) return [];
  const seen = new Set<string>();
  const vars = [...raw.sharedVariables.items].sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  return vars.map((v) => {
    const id = v.scope === "team" ? `variable:team:${v.key}` : v.scope === "project" ? `variable:project:${v.projectRef}:${v.key}` : `variable:environment:${v.projectRef}:${v.environmentName}:${v.key}`;
    const blocked = v.locked
      ? "locked"
      : v.value === undefined
        ? "needs_sensitive"
        : !isValidEnvKey(v.key)
          ? "invalid_key"
          : !isSafeEnvValue(v.value)
            ? "multiline"
            : ctx.sharedVarKeys.has(v.key)
              ? "exists"
              : seen.has(v.key)
                ? "duplicate_key"
                : undefined;
    if (!blocked) {
      seen.add(v.key);
      planned.set(id, { section: "sharedVariables", variable: v });
    }
    return entry({
      id,
      section: "sharedVariables",
      name: v.key,
      blocked,
      // Tugra injects a shared variable into EVERY app of the team; Coolify only into the apps that reference it.
      defaultSelected: false,
      notes: [note("warn", "team_wide")],
      detail: { scope: v.scope, key: v.key, ...(v.projectName ? { project: v.projectName } : {}), ...(v.environmentName ? { environment: v.environmentName } : {}) },
    });
  });
};

const storages: Builder = (raw, ctx, planned) => {
  if (!raw.storages.ok) return [];
  return raw.storages.items.map((s) => {
    const id = `storage:${s.ref}`;
    const blocked =
      s.type !== "s3"
        ? "unsupported_type"
        : !s.endpoint
          ? "no_endpoint"
          : !s.bucket || s.bucket.length > 63 || !BUCKET_RE.test(s.bucket)
            ? "invalid_bucket"
            : ctx.destinationKeys.has(destinationKey(s.endpoint, s.bucket))
              ? "exists"
              : undefined;
    const notes: SettingsNote[] = [];
    if (s.type === "s3") {
      notes.push(note("info", "credentials_not_exposed"));
      notes.push(note("info", "schedules_not_carried"));
      if (s.skipTlsVerification) notes.push(note("warn", "tls_verification_skipped"));
    }
    if (!blocked) planned.set(id, { section: "storages", storage: s });
    return entry({ id, section: "storages", name: s.name, blocked, defaultSelected: false, needs: blocked ? undefined : ["s3Credentials"], notes, detail: { type: s.type, endpoint: s.endpoint, bucket: s.bucket, region: s.region } });
  });
};

const scheduledTasks: Builder = (raw, ctx, planned) => {
  if (!raw.scheduledTasks.ok) return [];
  return raw.scheduledTasks.items.map((t) => {
    const id = `task:${t.resourceRef}:${t.ref}`;
    const cron = cronFromFrequency(t.frequency);
    const target = ctx.imported.get(t.resourceRef);
    const appId = target?.kind === "application" ? target.id : undefined;
    const name = t.name.length > TASK_NAME_MAX ? t.name.slice(0, TASK_NAME_MAX) : t.name;
    const blocked = !ctx.hasOperation ? "needs_import" : !appId ? "app_not_imported" : !cron ? "invalid_schedule" : ctx.taskKeys.has(taskKey(appId, name, t.command)) ? "exists" : undefined;
    const notes: SettingsNote[] = [];
    if (t.container) notes.push(note("info", "container_ignored"));
    if (t.name.length > TASK_NAME_MAX) notes.push(note("info", "name_truncated"));
    if (!t.enabled) notes.push(note("info", "source_disabled"));
    // Until cutover the source keeps running the same task against the old stack.
    notes.push(note("warn", "double_run"));
    if (!blocked && appId && cron) planned.set(id, { section: "scheduledTasks", task: { ...t, name }, cron, appId });
    return entry({
      id,
      section: "scheduledTasks",
      name: t.name,
      blocked,
      // Not pre-selected: the source still runs the same task until cutover, so scheduling it here is a deliberate choice.
      defaultSelected: false,
      notes,
      // The command is NOT shown: it can carry secrets.
      detail: { resource: t.resourceName, resourceKind: t.resourceKind, ...(cron ? { schedule: cron } : {}), enabled: t.enabled, ...(t.timeoutSec ? { timeoutSec: t.timeoutSec } : {}) },
    });
  });
};

const serverSettings: Builder = (raw, _ctx, planned) => {
  if (!raw.serverSettings.ok) return [];
  return raw.serverSettings.items.map((c) => {
    const id = `server:${c.serverRef}`;
    const cron = cronFromFrequency(c.frequency);
    const blocked = cron ? undefined : "invalid_schedule";
    const notes: SettingsNote[] = [];
    if (cron) {
      if (!c.forceCleanup && c.thresholdPct) notes.push(note("info", "cleanup_always"));
      if (c.deleteVolumes) notes.push(note("warn", "volumes_pruned"));
      if (c.deleteNetworks) notes.push(note("info", "networks_not_carried"));
    }
    if (!blocked && cron) planned.set(id, { section: "serverSettings", cleanup: c, cron });
    return entry({
      id,
      section: "serverSettings",
      name: c.serverName,
      blocked,
      // Not pre-selected: it rewrites a Tugra server's cleanup schedule, so the operator picks which server it is for.
      defaultSelected: false,
      needs: blocked ? undefined : ["server"],
      notes,
      detail: { server: c.serverName, ...(cron ? { schedule: cron } : {}), ...(c.thresholdPct ? { thresholdPct: c.thresholdPct } : {}), volumes: c.deleteVolumes },
    });
  });
};

const tags: Builder = (raw, ctx, planned) => {
  if (!raw.tags.ok) return [];
  return raw.tags.items.map((tag) => {
    const id = `tag:${tag.name}`;
    const targets = tag.resources.flatMap((r) => {
      const hit = ctx.imported.get(r.ref);
      return hit ? [hit] : [];
    });
    const tugraName = normalizeTags([tag.name])[0] ?? "";
    const blocked = !ctx.hasOperation ? "needs_import" : !tugraName ? "invalid_name" : targets.length === 0 ? "no_imported_resources" : undefined;
    const notes: SettingsNote[] = [];
    if (tugraName && tugraName !== tag.name) notes.push(note("info", "tag_normalized", { as: tugraName }));
    if (!blocked) planned.set(id, { section: "tags", tag, targets, tugraName });
    return entry({ id, section: "tags", name: tag.name, blocked, defaultSelected: true, notes, detail: { resources: tag.resources.length, imported: targets.length } });
  });
};

const members: Builder = (raw, ctx, planned) => {
  if (!raw.members.ok) return [];
  return raw.members.items.map((m) => {
    const id = `member:${m.email}`;
    const blocked = m.email === ctx.actorEmail?.toLowerCase() ? "self" : ctx.memberEmails.has(m.email) ? "exists" : undefined;
    const notes: SettingsNote[] = [];
    if (!m.role) notes.push(note("info", "role_unknown"));
    if (m.role === "owner") notes.push(note("info", "owner_not_carried"));
    if (ctx.pendingInviteEmails.has(m.email)) notes.push(note("info", "invite_pending"));
    if (!blocked) planned.set(id, { section: "members", member: m });
    // An invitation sends an email, so it is never pre-selected.
    return entry({ id, section: "members", name: m.email, blocked, defaultSelected: false, needs: blocked ? undefined : ["role"], notes, detail: { email: m.email, displayName: m.name, suggestedRole: suggestedRole(m.role) } });
  });
};

const BUILD: Record<SettingsSection, Builder> = { notifications, sharedVariables, storages, scheduledTasks, serverSettings, tags, members };
