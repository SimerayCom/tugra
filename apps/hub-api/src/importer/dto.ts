import { z } from "zod";
import { VOLUME_NAME_RE } from "./migration-volume";

/**
 * The REMOTE (copy-mode) source PaaS kinds the importer can connect to over an API with a stored session.
 * `local-docker` is deliberately NOT here — it adopts live containers in place and has no session/token.
 * The importer service, the apply executor and the MCP import tools derive their source-dispatch from this
 * one list. A new kind is added here AND as an explicit literal entry in the unions below (discriminatedUnion
 * needs literal discriminators) + its adapter in ImportSourceFactory.
 */
export const REMOTE_SOURCE_KINDS = ["coolify", "dokploy"] as const;
export type RemoteSourceKind = (typeof REMOTE_SOURCE_KINDS)[number];
export const isRemoteSourceKind = (k: string | undefined | null): k is RemoteSourceKind =>
  !!k && (REMOTE_SOURCE_KINDS as readonly string[]).includes(k);

/** Connect an external source PaaS (store an encrypted, short-lived session). Coolify (Bearer) or Dokploy
 *  (x-api-key) — both carry their key in `token`. */
export const ImportConnectSchema = z.object({
  sourceKind: z.enum(REMOTE_SOURCE_KINDS),
  teamId: z.string().min(1),
  baseUrl: z.string().url().max(2048),
  token: z.string().min(1).max(4096),
});
export type ImportConnectInput = z.infer<typeof ImportConnectSchema>;

/** Request body for the dry-run import plan: a local server to adopt, or a connected remote session. */
export const ImportPlanRequestSchema = z.discriminatedUnion("sourceKind", [
  z.object({ sourceKind: z.literal("local-docker"), serverId: z.string().min(1) }),
  z.object({ sourceKind: z.literal("coolify"), sessionId: z.string().min(1) }),
  z.object({ sourceKind: z.literal("dokploy"), sessionId: z.string().min(1) }),
]);
export type ImportPlanRequestInput = z.infer<typeof ImportPlanRequestSchema>;

/** Apply a previously-previewed plan. `planHash` binds the apply to the exact plan the caller reviewed:
 *  the server re-plans and refuses (409) if the source changed since. local-docker adopts in place; a remote
 *  source (coolify/dokploy) COPIES each app onto `targetServerId` (a fresh Tugra server/cluster). */
const planHash = z.string().regex(/^[a-f0-9]{32}$/, "invalid planHash");
/** Operator acknowledgement of an ACKABLE plan blocker (`app.env.unresolved` / `app.env.key.invalid`): "create the
 *  app WITHOUT those variables". Outside planHash (the apply still re-plans and compares the hash exactly). An
 *  omitted `itemRef` acknowledges every item carrying that code. `app.env.tokenReadOnly` and every other blocker
 *  can never be acknowledged — the enum is the allow-list. */
export const ImportAckSchema = z.object({
  code: z.enum(["app.env.unresolved", "app.env.key.invalid"]),
  itemRef: z.string().min(1).max(300).optional(),
});
export type ImportAck = z.infer<typeof ImportAckSchema>;

// ── Service import choices (Coolify services → stopped Tugra COMPOSE apps) ─────────────────────────────────────────
const SVC_NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, "invalid compose service name");
const HOSTNAME = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, "invalid hostname (lowercase, dotted)");
/** A pinned image reference supplied for one compose service (from the source probe, or typed by the operator). The
 *  transform additionally refuses a pin whose repository differs from the service's own image. */
export const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;
/** Per-service operator choices. Keys of `serviceChoices` are plan itemRefs. NOT part of the planHash. Everything here can
 *  only NARROW or rename what the importer does: it can never keep a member the safety gate rejects. */
export const ServiceChoiceSchema = z
  .object({
    skip: z.boolean().optional(),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}$/).optional(),
    environmentId: z.string().min(1).optional(),
    targetServerId: z.string().min(1).optional(),
    serviceDomains: z.array(z.object({ service: SVC_NAME, hostname: HOSTNAME, port: z.number().int().min(1).max(65535) }).strict()).max(20).optional(),
    hostnameMap: z.record(HOSTNAME, HOSTNAME).optional(),
    volumes: z
      .record(
        z.string().regex(VOLUME_NAME_RE),
        z
          .object({
            policy: z.enum(["copy", "empty", "skip"]),
            owner: z.object({ uid: z.number().int().min(0).max(65535), gid: z.number().int().min(0).max(65535) }).strict().optional(),
          })
          .strict(),
      )
      .optional(),
    dropMembers: z.array(SVC_NAME).max(32).optional(), // can only widen the dropped set
    pinImages: z.boolean().optional(), // default true when a pin exists
    pins: z.record(SVC_NAME, z.string().regex(IMAGE_REF_RE)).optional(), // service key -> image ref
    privateNetwork: z.boolean().optional(), // default true for an internal-only single-service stack
    hold: z.boolean().optional(), // default true for cloudflared only
  })
  .strict();
export type ServiceChoice = z.infer<typeof ServiceChoiceSchema>;
const serviceChoices = z.record(z.string().min(1).max(256), ServiceChoiceSchema).refine((r) => Object.keys(r).length <= 64, "at most 64 service choices");

const remoteApplyFields = {
  sessionId: z.string().min(1),
  targetServerId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  planHash,
  acks: z.array(ImportAckSchema).max(2000).optional(),
  serviceChoices: serviceChoices.optional(),
};
export const ImportApplySchema = z.discriminatedUnion("sourceKind", [
  z.object({ sourceKind: z.literal("local-docker"), serverId: z.string().min(1), planHash }),
  z.object({ sourceKind: z.literal("coolify"), ...remoteApplyFields }),
  z.object({ sourceKind: z.literal("dokploy"), ...remoteApplyFields }),
]);
export type ImportApplyInput = z.infer<typeof ImportApplySchema>;

/** Preview what the service import would do (pure transform against the live source), per service, with NO secret value
 *  or file content in the response. `choices` are the same per-service choices apply takes, keyed by plan itemRef. */
export const ImportServicesPreviewSchema = z.object({
  sessionId: z.string().min(1),
  sourceKind: z.enum(REMOTE_SOURCE_KINDS).optional(),
  choices: serviceChoices.optional(),
});
export type ImportServicesPreviewInput = z.infer<typeof ImportServicesPreviewSchema>;

/** Confirm body for the env-remap apply. `confirmToken` is the planHash the operator reviewed in the
 *  preview (a sha256 hex digest, 64 chars — distinct from the 32-char import planHash); the apply re-plans
 *  and refuses (409) if it no longer matches, so a stale diff is never written. */
export const ImportRemapEnvSchema = z.object({
  confirmToken: z.string().regex(/^[a-f0-9]{64}$/, "invalid confirmToken"),
});
export type ImportRemapEnvInput = z.infer<typeof ImportRemapEnvSchema>;

/** Body of `POST /import/git-links`: resolve, for the target server's team, how each imported git app would be linked. */
export const ImportGitLinksSchema = z.object({
  sessionId: z.string().min(1),
  targetServerId: z.string().min(1),
});
export type ImportGitLinksInput = z.infer<typeof ImportGitLinksSchema>;

/** Body of `POST /import/operations/:opId/git-links/relink`: optional per-app picks for ambiguous rows. */
export const ImportGitRelinkSchema = z.object({
  choices: z.record(z.string().min(1).max(300), z.string().min(1).max(100)).optional(),
});
export type ImportGitRelinkInput = z.infer<typeof ImportGitRelinkSchema>;
