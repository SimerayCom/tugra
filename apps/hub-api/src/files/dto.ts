import { z } from "zod";
import { ApiErrorSchema } from "../common/api-error";
import { assertSafeCtrPath, assertSafeFsPathV2 } from "../common/fs-path";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A refine that runs one of the hub's own path validators and surfaces its message. */
function pathRule(check: (p: string) => unknown) {
  return (p: string, ctx: z.RefinementCtx) => {
    try {
      check(p);
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: e instanceof Error ? e.message : "invalid path" });
    }
  };
}

const volumeKey = z.string().regex(NAME, "invalid volume");
const containerName = z.string().regex(NAME, "invalid container");
/** A volume-relative path; "" only where the root makes sense (stat/list). */
const volPath = z.string().max(4096).superRefine(pathRule((p) => assertSafeFsPathV2(p)));
const volPathOrRoot = z.string().max(4096).superRefine(pathRule((p) => assertSafeFsPathV2(p, { allowRoot: true })));
/** An absolute in-container path. Mutations additionally refuse "/". */
const ctrPathRead = z.string().max(4096).superRefine(pathRule((p) => assertSafeCtrPath(p)));
const ctrPathWrite = z.string().max(4096).superRefine(pathRule((p) => assertSafeCtrPath(p, { mutating: true })));

const mode = z
  .string()
  .regex(/^[0-7]{3,4}$/, "mode must be 3-4 octal digits")
  .refine((v) => parseInt(v, 8) <= 0o777, "setuid, setgid and sticky bits are not allowed");
const ifMatch = z.string().regex(/^\d{1,20}-\d{1,20}$/, "ifMatch must look like <size>-<mtimeNs>");

/** Query booleans travel as "0" | "1". */
const flag = z.enum(["0", "1"]).optional().transform((v) => v === "1");

// ── volume routes ──────────────────────────────────────────────────────────────────────────────────────────
export const VolStatQuerySchema = z.object({ volume: volumeKey, path: volPathOrRoot.default("") }).strict();
export type VolStatQuery = z.infer<typeof VolStatQuerySchema>;

export const VolContentQuerySchema = z.object({ volume: volumeKey, path: volPath }).strict();
export type VolContentQuery = z.infer<typeof VolContentQuerySchema>;

export const VolPutQuerySchema = z
  .object({ volume: volumeKey, path: volPath, overwrite: flag, mode: mode.optional(), ifMatch: ifMatch.optional(), acknowledgeRisk: flag })
  .strict();
export type VolPutQuery = z.infer<typeof VolPutQuerySchema>;

export const VolMkdirBodySchema = z.object({ volume: volumeKey, path: volPath, mode: mode.optional(), parents: z.boolean().optional() }).strict();
export type VolMkdirBody = z.infer<typeof VolMkdirBodySchema>;

export const VolRenameBodySchema = z.object({ volume: volumeKey, from: volPath, to: volPath, acknowledgeRisk: z.boolean().optional() }).strict();
export type VolRenameBody = z.infer<typeof VolRenameBodySchema>;

export const VolChmodBodySchema = z.object({ volume: volumeKey, path: volPath, mode, acknowledgeRisk: z.boolean().optional() }).strict();
export type VolChmodBody = z.infer<typeof VolChmodBodySchema>;

export const VolDeleteQuerySchema = z.object({ volume: volumeKey, path: volPath, recursive: flag, acknowledgeRisk: flag }).strict();
export type VolDeleteQuery = z.infer<typeof VolDeleteQuerySchema>;

// ── container routes (no acknowledgeRisk: the datastore guard is volume-only) ─────────────────────────────
export const CtrListQuerySchema = z.object({ container: containerName.optional(), path: ctrPathRead.default("/") }).strict();
export type CtrListQuery = z.infer<typeof CtrListQuerySchema>;

export const CtrStatQuerySchema = z.object({ container: containerName.optional(), path: ctrPathRead }).strict();
export type CtrStatQuery = z.infer<typeof CtrStatQuerySchema>;

export const CtrPutQuerySchema = z
  .object({ container: containerName.optional(), path: ctrPathWrite, overwrite: flag, mode: mode.optional(), ifMatch: ifMatch.optional() })
  .strict();
export type CtrPutQuery = z.infer<typeof CtrPutQuerySchema>;

export const CtrMkdirBodySchema = z.object({ container: containerName.optional(), path: ctrPathWrite, mode: mode.optional(), parents: z.boolean().optional() }).strict();
export type CtrMkdirBody = z.infer<typeof CtrMkdirBodySchema>;

export const CtrRenameBodySchema = z.object({ container: containerName.optional(), from: ctrPathWrite, to: ctrPathWrite }).strict();
export type CtrRenameBody = z.infer<typeof CtrRenameBodySchema>;

export const CtrChmodBodySchema = z.object({ container: containerName.optional(), path: ctrPathWrite, mode }).strict();
export type CtrChmodBody = z.infer<typeof CtrChmodBodySchema>;

export const CtrDeleteQuerySchema = z.object({ container: containerName.optional(), path: ctrPathWrite, recursive: flag }).strict();
export type CtrDeleteQuery = z.infer<typeof CtrDeleteQuerySchema>;

// ── response schemas (documentation + the CLI's generated types) ─────────────────────────────────────────
export const Fs2StatSchema = z.object({
  name: z.string(),
  type: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number(),
  mode: z.string().describe("octal permission bits, e.g. 0644"),
  mtime: z.number(),
  mtimeNs: z.number(),
  uid: z.number(),
  gid: z.number(),
  etag: z.string().describe("<size>-<mtimeNs>; send it back as ifMatch to avoid overwriting a concurrent change"),
  linkTarget: z.string().optional(),
  uname: z.string().optional(),
  gname: z.string().optional(),
});

export const FsWriteResultSchema = z.object({ path: z.string(), bytes: z.number(), sha256: z.string(), etag: z.string() });

export const FsContainerListingSchema = z.object({
  entries: z.array(z.object({ name: z.string(), type: z.enum(["file", "dir", "symlink", "other"]), size: z.number(), mode: z.string(), mtime: z.number() })),
  truncated: z.boolean(),
});

export const FilesMetaSchema = z.object({
  serverOnline: z.boolean(),
  clustered: z.boolean(),
  capabilities: z.object({ files: z.boolean(), filesWrite: z.boolean(), terminal: z.boolean() }),
  canTerminal: z.boolean(),
  agentSupportsFs2: z.boolean(),
  datastore: z.boolean(),
  volumes: z.array(
    z.object({ name: z.string(), writable: z.boolean(), reason: z.enum(["capability", "agent_old", "datastore_running", "offline", "deploy_in_progress"]).optional() }),
  ),
  container: z.object({
    available: z.boolean(),
    writable: z.boolean(),
    reason: z.enum(["clustered", "not_deployed", "capability", "permission", "agent_old", "offline", "deploy_in_progress"]).optional(),
    names: z.array(z.string()),
  }),
  limits: z.object({ maxUploadBytes: z.number(), maxDownloadBytes: z.number(), maxEditBytes: z.number() }),
});

/**
 * The typed error body of the file routes: the uniform ApiError plus a stable machine `code` (`exists`, `changed`,
 * `too_large`, `deploy_in_progress`, `datastore_running`, `rate_limited`, `busy`, `staging_full`, ...) the UI branches
 * on, and `retryAfterSec` on a per-user rate limit (also sent as `Retry-After`). Registered as an OpenAPI component.
 */
export const FsErrorBodySchema = ApiErrorSchema.extend({ code: z.string(), retryAfterSec: z.number().int().optional() });
