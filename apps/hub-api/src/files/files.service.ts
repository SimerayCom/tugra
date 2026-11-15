import { BadRequestException, HttpException, Injectable } from "@nestjs/common";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AGENT_FEATURE_FS2, type Fs2Fields, type Fs2Op, type Fs2ResultMsg, type Fs2Scope, type Fs2Stat, type FsEntry } from "@tugra/shared";
import { AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService } from "../applications/applications.service";
import { AuditService } from "../audit/audit.service";
import { containerName } from "../deploy/deploy-script";
import { assertSafeCtrPath, assertSafeFsPathV2 } from "../common/fs-path";
import { looksLikeDatastore } from "./datastore-guard";
import { FsPolicyException, FsRateLimitedException, FsRemoteException } from "./fs-errors";
import { FileOpLimiter } from "./fs-limiter";
import { assertDiskHeadroom, discardStaged, filesLimits, stageUpload, StagedStalledError, StagedTooLargeError, StagingBudget } from "./fs-staging";
import { attachmentDisposition } from "./fs-transfer";
import { FsTransferService } from "./fs-transfer.service";

/** Which file-manager target a request addresses: one declared volume key OR (container scope) a container. */
export type FsTarget = { volume: string } | { container: string };

type ReqFields = Omit<Fs2Fields, "reqId" | "exp" | "capability" | "timeoutMs">;

export interface FilesMeta {
  serverOnline: boolean;
  clustered: boolean;
  capabilities: { files: boolean; filesWrite: boolean; terminal: boolean };
  /** TEAM permission `terminal` (the container routes need it in addition to the server capability). */
  canTerminal: boolean;
  agentSupportsFs2: boolean;
  /** The app's image/compose/template looks like a database or broker (heuristic). */
  datastore: boolean;
  /**
   * `writable` is true when a write would be accepted. `datastore_running` is an ADVISORY on a writable volume: the
   * write still needs `acknowledgeRisk`, so the UI warns before the first mutation. Every other reason means not writable.
   */
  volumes: { name: string; writable: boolean; reason?: "capability" | "agent_old" | "datastore_running" | "offline" | "deploy_in_progress" }[];
  container: {
    available: boolean;
    writable: boolean;
    reason?: "clustered" | "not_deployed" | "capability" | "permission" | "agent_old" | "offline" | "deploy_in_progress";
    /** Single-container apps: the one container. COMPOSE apps: empty — the UI picks from the existing container list. */
    names: string[];
  };
  limits: { maxUploadBytes: number; maxDownloadBytes: number; maxEditBytes: number };
}

export interface WriteResultBody {
  path: string;
  bytes: number;
  sha256: string;
  etag: string;
}

const KIB512 = 512 * 1024;

/** write/read budget: 30s + 1s per 512 KiB, within [30s, 10min] (10 min matches the web proxy's 600s ceiling). */
export function transferTimeoutMs(size: number): number {
  return Math.min(10 * 60_000, Math.max(30_000, 30_000 + Math.ceil(size / KIB512) * 1000));
}

function pathFor(scope: Fs2Scope, path: string, opts: { mutating?: boolean; allowRoot?: boolean } = {}): string {
  return scope === "volume" ? assertSafeFsPathV2(path, { allowRoot: opts.allowRoot }) : assertSafeCtrPath(path, { mutating: opts.mutating });
}

const WRITE_VERBS: Partial<Record<Fs2Op, string>> = { write: "write", mkdir: "mkdir", rename: "rename", chmod: "chmod", delete: "delete", read: "download" };

/** Audit action: `app.file.<verb>` for volumes, `app.container_fs.<verb>` for the container filesystem. */
export function fsAuditAction(scope: Fs2Scope, op: Fs2Op): string {
  const verb = WRITE_VERBS[op] ?? op;
  return scope === "container" ? `app.container_fs.${verb}` : `app.file.${verb}`;
}

function failureCode(e: unknown): string {
  if (e instanceof FsRemoteException || e instanceof FsPolicyException) return e.code;
  if (e instanceof HttpException) {
    const r = e.getResponse();
    const code = typeof r === "object" && r !== null ? (r as { code?: unknown }).code : undefined;
    return typeof code === "string" ? code : `http_${e.getStatus()}`;
  }
  return "stream_failed";
}

interface Resolved {
  app: { id: string; status: string };
  serverId: string;
  scope: Fs2Scope;
  subject: string;
}

/** An admitted mutation: it holds an fs2 slot (and, for an upload, a concurrent-upload seat) until `release()`. */
interface Admitted extends Resolved {
  slot: () => void;
  release: () => void;
}

/** Concurrent uploads one user may have per server, and one app may have at once (admission control, `busy` 429). */
function maxConcurrentUploads(): number {
  const n = Number(process.env.FILES_MAX_CONCURRENT_UPLOADS);
  return Number.isInteger(n) && n > 0 ? n : 2;
}

const DENIED_RATE_LIMITED_WINDOW_MS = 60_000;

/** The audit reason code for a refusal that should leave an `app.file.denied` row; undefined = do not audit it. */
function denialCode(e: unknown): string | undefined {
  if (e instanceof FsRateLimitedException) return "rate_limited";
  if (e instanceof FsPolicyException) return e.code === "busy" ? undefined : e.code;
  if (e instanceof AgentOfflineException) return "offline";
  if (e instanceof HttpException) {
    const r = e.getResponse();
    const code = typeof r === "object" && r !== null ? (r as { code?: unknown }).code : undefined;
    if (e.getStatus() === 429) return undefined;
    if (typeof code !== "string") return e.getStatus() === 400 ? "bad_request" : undefined; // an unreasonable path
    return ["capability_not_granted", "agent_too_old", "deploy_in_progress", "bad_request"].includes(code) ? code : undefined;
  }
  return undefined;
}

/**
 * The file manager's WRITE side and the container filesystem. Every mutation runs the same pipeline, in this order:
 * resolve + team permission -> policy (deploy in progress, datastore) -> path validation -> offline / fs2 /
 * capability-set checks (BEFORE any upload body is read) -> admission (fs2 slot, upload seat: `busy`) -> per-user
 * limiter -> write-ahead audit (an audit failure aborts the op) -> dispatch -> an `app.file.failed` row on failure.
 * A refusal before the write-ahead row leaves an `app.file.denied` row. Audit rows carry the path and shape, NEVER content.
 */
@Injectable()
export class FilesService {
  private readonly budget = new StagingBudget();
  private readonly uploadSeats = new Map<string, number>();
  private readonly lastRateDenied = new Map<string, number>();

  constructor(
    private readonly apps: ApplicationsService,
    private readonly agentWs: AgentWsServer,
    private readonly audit: AuditService,
    private readonly transfers: FsTransferService,
    private readonly limiter: FileOpLimiter,
  ) {}

  // ── meta ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Drives the UI states (which controls to show and why a control is missing) without trial and error. */
  async meta(userId: string, appId: string): Promise<FilesMeta> {
    const ctx = await this.apps.fsContext(userId, appId);
    const { app } = ctx;
    const clustered = !!app.clusterId;
    const sid = ctx.volumeServerId;
    const online = !!sid && this.agentWs.isOnline(sid);
    const fs2 = !!sid && this.agentWs.agentSupports(sid, AGENT_FEATURE_FS2);
    const [files, filesWrite, terminal] = sid
      ? await Promise.all([
          this.agentWs.isCapabilityGranted(sid, "files"),
          this.agentWs.isCapabilityGranted(sid, "files_write"),
          this.agentWs.isCapabilityGranted(sid, "terminal"),
        ])
      : [false, false, false];
    const datastore = looksLikeDatastore(app);
    const running = app.status === "RUNNING";

    const volumeReason = (): FilesMeta["volumes"][number]["reason"] | undefined => {
      if (!online) return "offline";
      if (!fs2) return "agent_old";
      if (!files || !filesWrite) return "capability";
      if (ctx.deployInProgress) return "deploy_in_progress";
      return undefined;
    };
    const vr = volumeReason();
    const volumes: FilesMeta["volumes"] = ctx.volumeKeys.map((name) =>
      vr ? { name, writable: false, reason: vr } : datastore && running ? { name, writable: true, reason: "datastore_running" } : { name, writable: true },
    );

    let containerReason: FilesMeta["container"]["reason"];
    let containerAvailable = false;
    let containerWritable = false;
    if (clustered) containerReason = "clustered";
    else if (app.status === "NEW") containerReason = "not_deployed";
    else if (!ctx.canTerminal) containerReason = "permission";
    else if (!files || !terminal) containerReason = "capability";
    else if (!online) containerReason = "offline";
    else if (!fs2) containerReason = "agent_old";
    else {
      containerAvailable = true;
      if (!filesWrite) containerReason = "capability";
      else if (ctx.deployInProgress) containerReason = "deploy_in_progress";
      else containerWritable = true;
    }

    return {
      serverOnline: online,
      clustered,
      capabilities: { files, filesWrite, terminal },
      canTerminal: ctx.canTerminal,
      agentSupportsFs2: fs2,
      datastore,
      volumes,
      container: { available: containerAvailable, writable: containerWritable, reason: containerReason, names: app.source === "COMPOSE" ? [] : [containerName(app)] },
      limits: filesLimits(),
    };
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────

  private req(scope: Fs2Scope, op: Fs2Op, subject: string, path: string, extra: Partial<ReqFields> = {}): ReqFields {
    return { op, scope, subject, path, path2: "", mode: "", flags: "", size: 0, sha256: "", ifMatch: "", xfer: "", ...extra };
  }

  async stat(userId: string, appId: string, target: FsTarget, path: string): Promise<Fs2Stat> {
    const t = await this.apps.resolveFsTarget(userId, appId, target, { mutating: false });
    const p = pathFor(t.scope, path, { allowRoot: true });
    const r = await this.agentWs.sendFs2(t.serverId, this.req(t.scope, "stat", t.subject, p), 30_000);
    if (!r.stat) throw new FsRemoteException("failed", "the agent returned no stat");
    return r.stat;
  }

  /** Container directory listing (legacy FsEntry shape; honest-partial for huge trees). */
  async listContainer(userId: string, appId: string, target: { container: string }, path: string): Promise<{ entries: FsEntry[]; truncated: boolean }> {
    const t = await this.apps.resolveFsTarget(userId, appId, target, { mutating: false });
    const p = assertSafeCtrPath(path);
    const r = await this.agentWs.sendFs2(t.serverId, this.req("container", "list", t.subject, p), 20_000);
    return { entries: r.entries ?? [], truncated: r.truncated ?? false };
  }

  // ── mutation pipeline ──────────────────────────────────────────────────────────────────────────────────────

  /** Take one seat in the per-(user, server) and per-app concurrent-upload counters, or 429 `busy`. */
  private acquireUploadSeat(userId: string, serverId: string, appId: string): () => void {
    const max = maxConcurrentUploads();
    const keys = [`u|${userId}|${serverId}`, `a|${appId}`];
    if (keys.some((k) => (this.uploadSeats.get(k) ?? 0) >= max)) {
      throw new HttpException({ statusCode: 429, code: "busy", message: "too many uploads in flight — wait for one to finish" }, 429);
    }
    for (const k of keys) this.uploadSeats.set(k, (this.uploadSeats.get(k) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const k of keys) {
        const left = (this.uploadSeats.get(k) ?? 1) - 1;
        if (left <= 0) this.uploadSeats.delete(k);
        else this.uploadSeats.set(k, left);
      }
    };
  }

  /** `app.file.denied`: a request refused by policy, capability, path or the limiter (path + reason code, never content). */
  private async denied(userId: string, appId: string, target: FsTarget, op: Fs2Op, paths: string[], e: unknown): Promise<void> {
    const code = denialCode(e);
    if (!code) return;
    if (code === "rate_limited") {
      // A throttled caller must not flood the audit table (that would defeat the limiter): one row per window.
      const now = Date.now();
      if (now - (this.lastRateDenied.get(userId) ?? 0) < DENIED_RATE_LIMITED_WINDOW_MS) return;
      if (this.lastRateDenied.size > 10_000) this.lastRateDenied.clear();
      this.lastRateDenied.set(userId, now);
    }
    try {
      await this.audit.log({
        actor: userId,
        action: "app.file.denied",
        target: appId,
        meta: { op, scope: "container" in target ? "container" : "volume", paths: paths.map((p) => String(p).slice(0, 300)), code },
      });
    } catch {
      /* the refusal itself is what the caller must see */
    }
  }

  /**
   * Admission first, then the limiter and the write-ahead audit: a `busy` refusal (no fs2 slot, no upload seat) must not
   * burn a limiter token or leave a write-ahead row, because the web client retries it every few seconds. Policy,
   * capability, path and limiter refusals leave an `app.file.denied` row.
   */
  private async prepare(
    userId: string,
    appId: string,
    target: FsTarget,
    op: Fs2Op,
    o: { acknowledgeRisk?: boolean; paths: string[]; meta: Record<string, unknown> },
  ): Promise<Admitted> {
    const releases: Array<() => void> = [];
    const release = () => releases.forEach((r) => r());
    try {
      const t = await this.apps.resolveFsTarget(userId, appId, target, { mutating: true });
      if (t.scope === "volume" && t.app.status === "RUNNING" && looksLikeDatastore(t.app) && !o.acknowledgeRisk) {
        throw new FsPolicyException(409, "datastore_running", "this app looks like a database or broker and is running — editing its data files can corrupt it");
      }
      for (const p of o.paths) {
        pathFor(t.scope, p, { mutating: true });
      }
      await this.agentWs.assertFs2Ready(t.serverId, t.scope, op); // offline / agent_too_old / capability SET — before any body is read
      if (op === "write") releases.push(this.acquireUploadSeat(userId, t.serverId, t.app.id));
      const slot = this.agentWs.reserveFs2(t.serverId); // 429 busy BEFORE the limiter token and the audit row
      releases.push(slot);
      this.limiter.take(userId);
      await this.audit.log({
        actor: userId,
        action: fsAuditAction(t.scope, op),
        target: t.app.id,
        meta: { scope: t.scope, subject: t.subject, ...(o.acknowledgeRisk && t.scope === "volume" ? { acknowledgedRisk: true } : {}), ...o.meta },
      });
      return { ...t, slot, release };
    } catch (e) {
      release();
      await this.denied(userId, appId, target, op, o.paths, e);
      throw e;
    }
  }

  private async fail(userId: string, t: Resolved, op: Fs2Op, e: unknown): Promise<void> {
    try {
      await this.audit.log({ actor: userId, action: "app.file.failed", target: t.app.id, meta: { op, scope: t.scope, code: failureCode(e) } });
    } catch {
      /* the original failure is what the caller must see */
    }
  }

  private async dispatch<T>(userId: string, t: Resolved & { release?: () => void }, op: Fs2Op, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (e) {
      await this.fail(userId, t, op, e);
      throw e;
    } finally {
      t.release?.();
    }
  }

  async mkdir(userId: string, appId: string, target: FsTarget, b: { path: string; mode?: string; parents?: boolean; acknowledgeRisk?: boolean }): Promise<Fs2Stat> {
    const flags = b.parents ? "p" : "";
    const t = await this.prepare(userId, appId, target, "mkdir", { acknowledgeRisk: b.acknowledgeRisk, paths: [b.path], meta: { path: b.path, ...(b.mode ? { mode: b.mode } : {}), flags } });
    const r = await this.dispatch(userId, t, "mkdir", () => this.agentWs.sendFs2(t.serverId, this.req(t.scope, "mkdir", t.subject, b.path, { mode: b.mode ?? "", flags }), 30_000, { reservation: t.slot }));
    return this.statOrNominal(r, b.path, "dir");
  }

  async rename(userId: string, appId: string, target: FsTarget, b: { from: string; to: string; acknowledgeRisk?: boolean }): Promise<Fs2Stat> {
    const t = await this.prepare(userId, appId, target, "rename", { acknowledgeRisk: b.acknowledgeRisk, paths: [b.from, b.to], meta: { path: b.from, path2: b.to, flags: "" } });
    const r = await this.dispatch(userId, t, "rename", () => this.agentWs.sendFs2(t.serverId, this.req(t.scope, "rename", t.subject, b.from, { path2: b.to }), 30_000, { reservation: t.slot }));
    return this.statOrNominal(r, b.to, "other");
  }

  async chmod(userId: string, appId: string, target: FsTarget, b: { path: string; mode: string; acknowledgeRisk?: boolean }): Promise<Fs2Stat> {
    const t = await this.prepare(userId, appId, target, "chmod", { acknowledgeRisk: b.acknowledgeRisk, paths: [b.path], meta: { path: b.path, mode: b.mode, flags: "" } });
    const r = await this.dispatch(userId, t, "chmod", () => this.agentWs.sendFs2(t.serverId, this.req(t.scope, "chmod", t.subject, b.path, { mode: b.mode }), 30_000, { reservation: t.slot }));
    return this.statOrNominal(r, b.path, "other");
  }

  async remove(userId: string, appId: string, target: FsTarget, b: { path: string; recursive?: boolean; acknowledgeRisk?: boolean }): Promise<void> {
    const flags = b.recursive ? "r" : "";
    const t = await this.prepare(userId, appId, target, "delete", { acknowledgeRisk: b.acknowledgeRisk, paths: [b.path], meta: { path: b.path, recursive: !!b.recursive, flags } });
    await this.dispatch(userId, t, "delete", () => this.agentWs.sendFs2(t.serverId, this.req(t.scope, "delete", t.subject, b.path, { flags }), b.recursive ? 5 * 60_000 : 30_000, { reservation: t.slot }));
  }

  /**
   * mkdir/rename/chmod return the entry's stat. The change is ALREADY APPLIED when this runs, so a missing stat (the
   * agent's best-effort follow-up failed) must not turn a success into an error and invite a doomed retry: answer with a
   * nominal stat (zeroed numbers, empty etag) instead.
   */
  private statOrNominal(r: Fs2ResultMsg, p: string, type: Fs2Stat["type"]): Fs2Stat {
    return r.stat ?? { name: p.slice(p.lastIndexOf("/") + 1), type, size: 0, mode: "", mtime: 0, mtimeNs: 0, uid: 0, gid: 0, etag: "" };
  }

  // ── upload ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Stream the request body into hub staging (the hub hashes it), then let the agent pull it over a signed
   * single-use URL and apply it atomically. Everything that can refuse the request (permission, policy, path,
   * offline/too-old/capability, limiter, audit, size cap, staging budget) runs BEFORE the first body byte is read.
   * The staged file and the transfer are released on success, failure AND client abort.
   */
  async upload(
    userId: string,
    appId: string,
    target: FsTarget,
    q: { path: string; overwrite?: boolean; mode?: string; ifMatch?: string; acknowledgeRisk?: boolean },
    req: IncomingMessage,
  ): Promise<{ created: boolean; body: WriteResultBody }> {
    const lim = filesLimits();
    const rawLen = req.headers["content-length"];
    if (typeof rawLen !== "string" || !/^\d{1,15}$/.test(rawLen)) throw new HttpException("Content-Length is required", 411);
    const len = Number(rawLen);
    if (len > lim.maxUploadBytes) throw new FsPolicyException(413, "too_large", `upload exceeds the ${lim.maxUploadBytes}-byte limit`);

    const t = await this.prepare(userId, appId, target, "write", {
      acknowledgeRisk: q.acknowledgeRisk,
      paths: [q.path],
      meta: { path: q.path, size: len, ...(q.mode ? { mode: q.mode } : {}), overwrite: !!q.overwrite, flags: q.overwrite ? "o" : "" },
    });

    return this.dispatch(userId, t, "write", async () => {
      // Admission control BEFORE the first body byte is read: prepare() already holds the per-server fs2 slot and the
      // concurrent-upload seat (429 busy); what is left here is staging space (507).
      const slot = t.slot;
      let release: (() => void) | undefined;
      let stagedPath: string | undefined;
      let xferId: string | undefined;
      try {
        release = this.budget.reserve(len); // 507 staging_full when the hub is holding too much already
        await assertDiskHeadroom(len);
        let staged;
        try {
          staged = await stageUpload(req, len);
        } catch (e) {
          if (e instanceof StagedStalledError) throw new FsPolicyException(408, "upload_too_slow", "the upload was too slow and was cancelled");
          if (e instanceof StagedTooLargeError) throw new BadRequestException({ statusCode: 400, code: "bad_request", message: "the body is longer than its Content-Length" });
          if ((e as { code?: string }).code === "ENOSPC") throw new FsPolicyException(507, "staging_full", "insufficient staging storage");
          throw new BadRequestException({ statusCode: 400, code: "bad_request", message: "the upload did not complete" });
        }
        stagedPath = staged.path;
        if (staged.bytes !== len) throw new BadRequestException({ statusCode: 400, code: "bad_request", message: "the body is shorter than its Content-Length" });
        // The body may have taken minutes: re-check that no deploy started meanwhile (sendFs2 re-checks the capability set).
        await this.apps.assertNoActiveDeploy(t.app.id);
        const reg = this.transfers.registerUpload({ serverId: t.serverId, appId: t.app.id, stagedPath: staged.path, size: len, sha256: staged.sha256 });
        xferId = reg.id;
        const r = await this.agentWs.sendFs2(
          t.serverId,
          this.req(t.scope, "write", t.subject, q.path, {
            mode: q.mode ?? "",
            flags: q.overwrite ? "o" : "",
            size: len,
            sha256: staged.sha256,
            ifMatch: q.ifMatch ?? "",
            xfer: reg.path,
          }),
          transferTimeoutMs(len),
          { reservation: slot },
        );
        return { created: r.created === true, body: { path: q.path, bytes: r.bytes ?? len, sha256: r.sha256 ?? staged.sha256, etag: r.etag ?? "" } };
      } finally {
        slot();
        release?.();
        if (xferId) this.transfers.release(xferId);
        await discardStaged(stagedPath);
      }
    });
  }

  // ── download ───────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Relay a file from the agent to the browser WITHOUT staging it on the hub: the agent PUTs the bytes to a signed
   * single-use URL and the hub pipes them straight into the browser response (Content-Length known from stat, so
   * the browser shows progress and backpressure is end to end). A failure before the headers go out surfaces as the
   * typed JSON error; a failure after them destroys the response, so the browser sees a FAILED download, never a
   * truncated "success".
   */
  async download(userId: string, appId: string, target: FsTarget, path: string, res: ServerResponse): Promise<void> {
    const t = await this.apps.resolveFsTarget(userId, appId, target, { mutating: false });
    const p = pathFor(t.scope, path);
    await this.agentWs.assertFs2Ready(t.serverId, t.scope, "read");
    await this.audit.log({ actor: userId, action: fsAuditAction(t.scope, "read"), target: t.app.id, meta: { scope: t.scope, subject: t.subject, path: p, flags: "" } });
    await this.dispatch(userId, t, "read", async () => {
      const st = await this.agentWs.sendFs2(t.serverId, this.req(t.scope, "stat", t.subject, p), 30_000);
      const stat = st.stat;
      if (!stat) throw new FsRemoteException("failed", "the agent returned no stat");
      if (stat.type !== "file") throw new FsRemoteException(stat.type === "dir" ? "is_dir" : "not_regular", "only regular files can be downloaded");
      const max = filesLimits().maxDownloadBytes;
      if (stat.size > max) throw new FsPolicyException(413, "too_large", `file exceeds the ${max}-byte download limit`);
      const base = p.slice(p.lastIndexOf("/") + 1);
      const reg = this.transfers.registerDownload({
        serverId: t.serverId,
        appId: t.app.id,
        size: stat.size,
        sink: res,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(stat.size),
          "Content-Disposition": attachmentDisposition(base),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "sandbox",
          ETag: `"${stat.etag}"`,
        },
      });
      const sent = this.agentWs.sendFs2(t.serverId, this.req(t.scope, "read", t.subject, p, { size: stat.size, xfer: reg.path }), transferTimeoutMs(stat.size));
      sent.catch(() => undefined); // observed below; never an unhandled rejection
      try {
        await Promise.all([sent, reg.done]);
      } catch (first) {
        // A relay error (the bytes stopped) usually arrives just before the agent's own typed reason (changed, denied,
        // ...). Give the agent a moment so the audit row and the JSON error carry the real cause, not "stream failed".
        const e = first instanceof FsRemoteException ? first : await Promise.race([sent.then(() => first, (x: unknown) => x), new Promise((r) => setTimeout(() => r(first), 1500))]);
        reg.cancel(e instanceof Error ? e : new Error("download failed"));
        if (res.headersSent) {
          // Mid-body: the browser must see a FAILED download (never a clean end), and the audit trail must show it.
          await this.fail(userId, t, "read", e);
          res.destroy();
          return;
        }
        throw e;
      } finally {
        this.transfers.release(reg.id);
      }
    });
  }
}
