/**
 * Settings carried by an import (not resources): notification channels, shared variables, S3 storages, scheduled
 * tasks, server cleanup, tags and team members. Two shapes live here:
 *
 *  - the PREVIEW (`SettingsPreview`): what the review screen shows. SECRET-FREE by construction: it only has names,
 *    codes and booleans ("a bot token is readable"), never a token, a webhook URL, a key or a variable value.
 *  - the RAW read (`RawSettings`): the same facts plus the secret values, held in memory on the hub for the length of
 *    one request. It is never serialised into a response, an audit row or a log.
 */
import type { EventType } from "@tugra/shared";

export const SETTINGS_SECTIONS = ["notifications", "sharedVariables", "storages", "scheduledTasks", "serverSettings", "tags", "members"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Why a whole section could not be read from the source. `not_exposed` = the source API has no such endpoint. */
export type UnavailableReason = "not_exposed" | "forbidden" | "error";

/** A fixed, translatable note on an entry: a code plus plain params (names and numbers, never values). */
export interface SettingsNote {
  level: "info" | "warn";
  code: string;
  params?: Record<string, string | number>;
}

/** What the operator must still supply for an entry to be applied. */
export type SettingsNeed = "s3Credentials" | "server" | "role";

export interface SettingsEntry {
  id: string;
  section: SettingsSection;
  /** A name taken from the source (a storage, a task, a server, a tag, an email) or the channel type slug. */
  name: string;
  selectable: boolean;
  defaultSelected: boolean;
  /** Why the entry cannot be selected (a fixed code), when `selectable` is false. */
  blocked?: string;
  notes: SettingsNote[];
  needs?: SettingsNeed[];
  /** Secret-free facts for the card (shape depends on the section). */
  detail: Record<string, unknown>;
}

export interface SettingsSectionPreview {
  section: SettingsSection;
  available: boolean;
  reason?: UnavailableReason;
  /** Some reads of the section failed (the entries are what could be read). */
  partial?: boolean;
  entries: SettingsEntry[];
}

export interface SettingsPreview {
  /** False for a source that carries no settings (Dokploy, local Docker). */
  supported: boolean;
  sections: SettingsSectionPreview[];
}

// ── RAW read (server only) ───────────────────────────────────────────────────────────────────────

export type Read<T> = { ok: true; items: T[]; partial?: boolean } | { ok: false; reason: UnavailableReason };

export type ChannelKind = "telegram" | "discord" | "slack" | "pushover" | "webhook" | "email";

/** One enabled event of a source channel, with the topic it posts into (Telegram). */
export interface RawChannelEvent {
  event: string;
  threadId?: string;
}

export interface RawChannel {
  kind: ChannelKind;
  enabled: boolean;
  /** The bot token / webhook URL / key were returned (a token without read:sensitive gets none of them). */
  secretsReadable: boolean;
  /** The channel was set up in the source (switched on, or it holds a credential or a destination). Absent = not known, treated as set up. */
  configured?: boolean;
  /** The channel sends through the source instance's own mail settings, which Tugra cannot read. */
  instanceEmail?: boolean;
  events: RawChannelEvent[];
  /** The Tugra provider config for this channel (SECRET-BEARING, server only). Empty when not readable. */
  config: Record<string, string>;
  /** Tugra provider type the config is for (`smtp` | `resend` for email). */
  providerType: string;
}

export interface RawSharedVar {
  scope: "team" | "project" | "environment";
  projectRef?: string;
  projectName?: string;
  environmentName?: string;
  key: string;
  /** Present only when the token may read values (SECRET, server only). */
  value?: string;
  locked: boolean;
}

export interface RawStorage {
  ref: string;
  name: string;
  type: string;
  endpoint: string;
  bucket: string;
  region: string;
  skipTlsVerification: boolean;
}

export interface RawTask {
  resourceKind: "application" | "service";
  resourceRef: string;
  resourceName: string;
  ref: string;
  name: string;
  command: string;
  frequency: string;
  container?: string;
  timeoutSec?: number;
  enabled: boolean;
}

export interface RawServerCleanup {
  serverRef: string;
  serverName: string;
  frequency: string;
  thresholdPct?: number;
  deleteVolumes: boolean;
  deleteNetworks: boolean;
  forceCleanup: boolean;
}

export interface RawTag {
  name: string;
  resources: Array<{ kind: "application" | "database" | "service"; ref: string; name: string }>;
}

export interface RawMember {
  email: string;
  name: string;
  /** The source role when the API reports one (`owner` | `admin` | `member` | `viewer`, lower-case). */
  role?: string;
}

export interface RawSettings {
  notifications: Read<RawChannel>;
  sharedVariables: Read<RawSharedVar>;
  storages: Read<RawStorage>;
  scheduledTasks: Read<RawTask>;
  serverSettings: Read<RawServerCleanup>;
  tags: Read<RawTag>;
  members: Read<RawMember>;
}

/** One planned Tugra channel out of a source channel: a Telegram topic gets a channel of its own. */
export interface ChannelGroup {
  threadId?: string;
  coolifyEvents: string[];
  tugraEvents: EventType[];
}

/** What the target team already has, so the preview can say "already in Tugra" (names/keys only). */
export interface TargetContext {
  channelNames: ReadonlySet<string>;
  sharedVarKeys: ReadonlySet<string>;
  /** `endpoint|bucket` of the team's backup destinations (lower-cased, no trailing slash). */
  destinationKeys: ReadonlySet<string>;
  memberEmails: ReadonlySet<string>;
  pendingInviteEmails: ReadonlySet<string>;
  /** The importing user's own email (never invited). */
  actorEmail?: string;
  /** Source resource ref -> imported Tugra resource, from the import operation (empty without one). */
  imported: ReadonlyMap<string, { kind: "application" | "database"; id: string }>;
  hasOperation: boolean;
  /** `appId|name|command` of the tasks the imported apps already have. */
  taskKeys: ReadonlySet<string>;
}
