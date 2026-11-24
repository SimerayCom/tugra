/**
 * Settings carried by an import (mirrors the hub's `importer/settings/settings-types.ts`; secret-free by construction:
 * the preview never holds a token, a webhook URL, a key or a variable value). Pure helpers for the review panel.
 */
export const SETTINGS_SECTIONS = ["notifications", "sharedVariables", "storages", "scheduledTasks", "serverSettings", "tags", "members"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type UnavailableReason = "not_exposed" | "forbidden" | "error";

export interface SettingsNote {
  level: "info" | "warn";
  code: string;
  params?: Record<string, string | number>;
}

export interface SettingsEntry {
  id: string;
  section: SettingsSection;
  name: string;
  selectable: boolean;
  defaultSelected: boolean;
  blocked?: string;
  notes: SettingsNote[];
  needs?: Array<"s3Credentials" | "server" | "role">;
  detail: Record<string, unknown>;
}

export interface SettingsSectionPreview {
  section: SettingsSection;
  available: boolean;
  reason?: UnavailableReason;
  partial?: boolean;
  entries: SettingsEntry[];
}

export interface SettingsPreview {
  supported: boolean;
  sections: SettingsSectionPreview[];
}

export interface SettingsEntryResult {
  id: string;
  section: SettingsSection;
  status: "created" | "skipped" | "failed";
  code?: string;
  channels?: Array<{ id: string; name: string; skipped?: boolean }>;
  recoveryKey?: string;
  targetId?: string;
}

export interface SettingsApplyResult {
  results: SettingsEntryResult[];
  counts: { created: number; skipped: number; failed: number };
}

export interface SettingsApplyBody {
  sessionId: string;
  sourceKind?: "coolify" | "dokploy";
  opId?: string;
  teamId?: string;
  select: string[];
  serverMap?: Record<string, string>;
  s3Credentials?: Record<string, { accessKey: string; secretKey: string }>;
  memberRoles?: Record<string, "ADMIN" | "VIEWER">;
  confirmInvites?: boolean;
}

/** What the operator typed or picked next to the entries (kept apart from the preview, which never has secrets). */
export interface SettingsInputs {
  selected: ReadonlySet<string>;
  s3: Readonly<Record<string, { accessKey: string; secretKey: string }>>;
  servers: Readonly<Record<string, string>>;
  roles: Readonly<Record<string, "ADMIN" | "VIEWER">>;
  confirmInvites: boolean;
}

/** The entries that start ticked: selectable and flagged by the hub as a sensible default. */
export function initialSelection(p: SettingsPreview): Set<string> {
  return new Set(p.sections.flatMap((s) => s.entries.filter((e) => e.selectable && e.defaultSelected).map((e) => e.id)));
}

export const allEntries = (p: SettingsPreview): SettingsEntry[] => p.sections.flatMap((s) => s.entries);

/** The source server ref of a `server:<ref>` entry. */
export const serverRefOf = (e: SettingsEntry): string => e.id.slice("server:".length);

/** What a ticked entry still lacks before it can be sent (a fixed code the panel shows next to the field). */
export function missingInput(e: SettingsEntry, inp: SettingsInputs): "s3Credentials" | "server" | null {
  if (e.needs?.includes("s3Credentials")) {
    const c = inp.s3[e.id];
    if (!c || !c.accessKey.trim() || !c.secretKey.trim()) return "s3Credentials";
  }
  if (e.needs?.includes("server") && !inp.servers[e.id]) return "server";
  return null;
}

/**
 * Ticked server entries that point at a Tugra server an earlier ticked entry already points at. A server holds ONE cleanup
 * config, so a second source server on it would overwrite the first: it must pick another server.
 */
export function duplicateServerEntries(p: SettingsPreview, inp: SettingsInputs): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const e of allEntries(p)) {
    if (!e.selectable || !e.needs?.includes("server") || !inp.selected.has(e.id)) continue;
    const target = inp.servers[e.id];
    if (!target) continue;
    if (seen.has(target)) dup.add(e.id);
    else seen.add(target);
  }
  return dup;
}

/** The ticked entries that can be sent as they stand. */
export function readySelection(p: SettingsPreview, inp: SettingsInputs): SettingsEntry[] {
  const dup = duplicateServerEntries(p, inp);
  return allEntries(p).filter((e) => e.selectable && inp.selected.has(e.id) && missingInput(e, inp) === null && !dup.has(e.id));
}

/** Invitations send email: the confirmation is required whenever a member is ticked. */
export const needsInviteConfirmation = (p: SettingsPreview, inp: SettingsInputs): boolean => allEntries(p).some((e) => e.section === "members" && e.selectable && inp.selected.has(e.id));

/** The request body. Only what the ticked entries need is sent (no stray keys, no keys of an unticked storage). */
export function buildApplyBody(p: SettingsPreview, inp: SettingsInputs, ctx: { sessionId: string; sourceKind: "coolify" | "dokploy"; opId?: string; teamId?: string }): SettingsApplyBody {
  const ready = readySelection(p, inp);
  const body: SettingsApplyBody = { sessionId: ctx.sessionId, sourceKind: ctx.sourceKind, select: ready.map((e) => e.id) };
  if (ctx.opId) body.opId = ctx.opId;
  if (ctx.teamId) body.teamId = ctx.teamId;
  const servers = ready.filter((e) => e.needs?.includes("server"));
  if (servers.length) body.serverMap = Object.fromEntries(servers.map((e) => [serverRefOf(e), inp.servers[e.id]]));
  const s3 = ready.filter((e) => e.needs?.includes("s3Credentials"));
  if (s3.length) body.s3Credentials = Object.fromEntries(s3.map((e) => [e.id, { accessKey: inp.s3[e.id].accessKey.trim(), secretKey: inp.s3[e.id].secretKey.trim() }]));
  const members = ready.filter((e) => e.section === "members");
  if (members.length) {
    body.memberRoles = Object.fromEntries(members.map((e) => [e.id, inp.roles[e.id] ?? ((e.detail.suggestedRole as "ADMIN" | "VIEWER" | undefined) ?? "VIEWER")]));
    body.confirmInvites = inp.confirmInvites;
  }
  return body;
}

/** Literal i18n keys (so the static key-usage check sees them) for every code the hub can send. */
export const BLOCKED_KEY: Record<string, string> = {
  needs_sensitive: "import.settings.blocked.needs_sensitive",
  email_instance_settings: "import.settings.blocked.email_instance_settings",
  exists: "import.settings.blocked.exists",
  locked: "import.settings.blocked.locked",
  invalid_key: "import.settings.blocked.invalid_key",
  multiline: "import.settings.blocked.multiline",
  duplicate_key: "import.settings.blocked.duplicate_key",
  unsupported_type: "import.settings.blocked.unsupported_type",
  no_endpoint: "import.settings.blocked.no_endpoint",
  invalid_bucket: "import.settings.blocked.invalid_bucket",
  needs_import: "import.settings.blocked.needs_import",
  app_not_imported: "import.settings.blocked.app_not_imported",
  invalid_schedule: "import.settings.blocked.invalid_schedule",
  invalid_name: "import.settings.blocked.invalid_name",
  no_imported_resources: "import.settings.blocked.no_imported_resources",
  self: "import.settings.blocked.self",
};

export const NOTE_KEY: Record<string, string> = {
  events_not_carried: "import.settings.note.events_not_carried",
  topics_split: "import.settings.note.topics_split",
  source_disabled: "import.settings.note.source_disabled",
  double_send: "import.settings.note.double_send",
  team_wide: "import.settings.note.team_wide",
  credentials_not_exposed: "import.settings.note.credentials_not_exposed",
  schedules_not_carried: "import.settings.note.schedules_not_carried",
  tls_verification_skipped: "import.settings.note.tls_verification_skipped",
  container_ignored: "import.settings.note.container_ignored",
  name_truncated: "import.settings.note.name_truncated",
  cleanup_always: "import.settings.note.cleanup_always",
  volumes_pruned: "import.settings.note.volumes_pruned",
  double_run: "import.settings.note.double_run",
  networks_not_carried: "import.settings.note.networks_not_carried",
  tag_normalized: "import.settings.note.tag_normalized",
  role_unknown: "import.settings.note.role_unknown",
  owner_not_carried: "import.settings.note.owner_not_carried",
  invite_pending: "import.settings.note.invite_pending",
};

/** Notes that matter BEFORE the operator ticks the entry (they stay visible, not behind "More"). */
export const INLINE_NOTE_CODES: ReadonlySet<string> = new Set(["volumes_pruned", "double_send", "double_run"]);

export const RESULT_CODE_KEY: Record<string, string> = {
  ...BLOCKED_KEY,
  unknown_entry: "import.settings.result.code.unknown_entry",
  forbidden: "import.settings.result.code.forbidden",
  conflict: "import.settings.result.code.conflict",
  not_found: "import.settings.result.code.not_found",
  invalid: "import.settings.result.code.invalid",
  failed: "import.settings.result.code.failed",
  credentials_required: "import.settings.result.code.credentials_required",
  server_required: "import.settings.result.code.server_required",
  server_not_found: "import.settings.result.code.server_not_found",
  server_duplicate: "import.settings.result.code.server_duplicate",
  confirmation_required: "import.settings.result.code.confirmation_required",
};
