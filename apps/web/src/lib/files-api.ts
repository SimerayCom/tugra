import { API_BASE, ApiError, TG_CSRF, apiFetch, parseApiErrorBody, readCookie, tryRefresh } from "./api";
import { decodeForEdit, isCrlfOnly } from "./file-utils";
import type { FileListing } from "./types";

// Typed client for the file manager's write side and the container filesystem. JSON calls ride the shared
// `apiFetch` (CSRF + 401 refresh + typed ApiError.code); uploads use XHR for progress/abort; downloads are plain
// same-origin links (the cookie authenticates them, no blob is ever held in memory).

export type FsScope = "volume" | "container";
/** Which thing a request addresses: one declared volume (by key) or a container (by name; "" for the app's own). */
export interface FsTarget {
  scope: FsScope;
  name: string;
}

export interface FilesMeta {
  serverOnline: boolean;
  clustered: boolean;
  capabilities: { files: boolean; filesWrite: boolean; terminal: boolean };
  canTerminal: boolean;
  agentSupportsFs2: boolean;
  datastore: boolean;
  volumes: { name: string; writable: boolean; reason?: "capability" | "agent_old" | "datastore_running" | "offline" | "deploy_in_progress" }[];
  container: {
    available: boolean;
    writable: boolean;
    reason?: "clustered" | "not_deployed" | "capability" | "permission" | "agent_old" | "offline" | "deploy_in_progress";
    names: string[];
  };
  limits: { maxUploadBytes: number; maxDownloadBytes: number; maxEditBytes: number };
}

export interface FsStat {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mode: string; // octal, e.g. "0644"
  mtime: number;
  mtimeNs: number;
  uid: number;
  gid: number;
  etag: string;
  linkTarget?: string;
}

export interface FsWriteResult {
  path: string;
  bytes: number;
  sha256: string;
  etag: string;
}

const base = (id: string, scope: FsScope) => `/apps/${id}/${scope === "volume" ? "files" : "container-files"}`;
/** `volume=` for volumes, `container=` for the container filesystem. */
const key = (t: FsTarget) => (t.scope === "volume" ? "volume" : "container");

function qs(t: FsTarget, extra: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  if (t.scope === "volume" || t.name) q.set(key(t), t.name);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") q.set(k, v);
  return q.toString();
}

export const filesApi = {
  filesMeta(id: string) {
    return apiFetch<FilesMeta>(`/apps/${id}/files/meta`);
  },
  statFile(id: string, t: FsTarget, path: string) {
    return apiFetch<FsStat>(`${base(id, t.scope)}/stat?${qs(t, { path })}`);
  },
  /** Container directory listing (same entry shape as the legacy volume list). */
  listContainerFiles(id: string, container: string, path: string) {
    return apiFetch<FileListing>(`${base(id, "container")}?${qs({ scope: "container", name: container }, { path })}`);
  },
  mkdir(id: string, t: FsTarget, path: string, o: { mode?: string; parents?: boolean; acknowledgeRisk?: boolean } = {}) {
    return apiFetch<FsStat>(`${base(id, t.scope)}/mkdir`, {
      method: "POST",
      body: JSON.stringify({ [key(t)]: t.name, path, ...(o.mode ? { mode: o.mode } : {}), ...(o.parents ? { parents: true } : {}), ...(t.scope === "volume" && o.acknowledgeRisk ? { acknowledgeRisk: true } : {}) }),
    });
  },
  rename(id: string, t: FsTarget, from: string, to: string, o: { acknowledgeRisk?: boolean } = {}) {
    return apiFetch<FsStat>(`${base(id, t.scope)}/rename`, {
      method: "POST",
      body: JSON.stringify({ [key(t)]: t.name, from, to, ...(t.scope === "volume" && o.acknowledgeRisk ? { acknowledgeRisk: true } : {}) }),
    });
  },
  chmod(id: string, t: FsTarget, path: string, mode: string, o: { acknowledgeRisk?: boolean } = {}) {
    return apiFetch<FsStat>(`${base(id, t.scope)}/chmod`, {
      method: "POST",
      body: JSON.stringify({ [key(t)]: t.name, path, mode, ...(t.scope === "volume" && o.acknowledgeRisk ? { acknowledgeRisk: true } : {}) }),
    });
  },
  deleteEntry(id: string, t: FsTarget, path: string, o: { recursive?: boolean; acknowledgeRisk?: boolean } = {}) {
    return apiFetch<void>(
      `${base(id, t.scope)}?${qs(t, { path, recursive: o.recursive ? "1" : undefined, acknowledgeRisk: t.scope === "volume" && o.acknowledgeRisk ? "1" : undefined })}`,
      { method: "DELETE" },
    );
  },
};

/** A same-origin GET URL that downloads the file (use as `<a href download>`; the session cookie authenticates it). */
export function downloadHref(id: string, t: FsTarget, path: string): string {
  return `${API_BASE}${base(id, t.scope)}/content?${qs(t, { path })}`;
}

// ── upload (XHR: progress + abort) ───────────────────────────────────────────────────────────────────────────

export interface UploadOptions {
  id: string;
  target: FsTarget;
  path: string;
  body: Blob;
  overwrite?: boolean;
  mode?: string;
  ifMatch?: string;
  acknowledgeRisk?: boolean;
  /** bytes sent so far / total bytes of the body */
  onProgress?: (loaded: number, total: number) => void;
}

export interface UploadHandle {
  promise: Promise<FsWriteResult & { created: boolean }>;
  abort: () => void;
}

export class UploadAbortedError extends Error {
  constructor() {
    super("upload aborted");
  }
}

/** The URL an upload PUTs to. */
export function uploadUrl(o: Pick<UploadOptions, "id" | "target" | "path" | "overwrite" | "mode" | "ifMatch" | "acknowledgeRisk">): string {
  const t = o.target;
  return `${API_BASE}${base(o.id, t.scope)}/content?${qs(t, {
    path: o.path,
    overwrite: o.overwrite ? "1" : undefined,
    mode: o.mode,
    ifMatch: o.ifMatch,
    acknowledgeRisk: t.scope === "volume" && o.acknowledgeRisk ? "1" : undefined,
  })}`;
}

/**
 * PUT a body to the hub as a raw octet-stream via XHR. Mirrors apiFetch's session handling: credentials, the
 * double-submit CSRF header, and one refresh-and-retry on a 401. `abort()` cancels the in-flight request.
 */
export function uploadFile(o: UploadOptions): UploadHandle {
  let xhr: XMLHttpRequest | null = null;
  let aborted = false;

  const send = (retry: boolean): Promise<FsWriteResult & { created: boolean }> =>
    new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      xhr = x;
      x.open("PUT", uploadUrl(o));
      x.withCredentials = true;
      x.setRequestHeader("content-type", "application/octet-stream");
      const csrf = readCookie(TG_CSRF);
      if (csrf) x.setRequestHeader("x-csrf-token", csrf);
      x.upload.onprogress = (e) => {
        if (e.lengthComputable) o.onProgress?.(e.loaded, e.total);
      };
      x.onabort = () => reject(new UploadAbortedError());
      x.onerror = () => reject(new ApiError(0, "network error", "network"));
      x.onload = () => {
        if (x.status === 401 && retry && !aborted) {
          void tryRefresh().then((ok) => (ok && !aborted ? send(false).then(resolve, reject) : reject(new ApiError(401, "unauthorized"))));
          return;
        }
        let parsed: unknown;
        try {
          parsed = x.responseText ? JSON.parse(x.responseText) : undefined;
        } catch {
          parsed = undefined;
        }
        if (x.status >= 200 && x.status < 300) {
          resolve({ ...(parsed as FsWriteResult), created: x.status === 201 });
          return;
        }
        const e = parseApiErrorBody(parsed, x.statusText || `HTTP ${x.status}`);
        reject(new ApiError(x.status, e.message, e.code, e.data));
      };
      x.send(o.body);
    });

  return {
    promise: send(true),
    abort: () => {
      aborted = true;
      xhr?.abort();
    },
  };
}

// ── text read (editor) ───────────────────────────────────────────────────────────────────────────────────────

export class NotEditableError extends Error {
  constructor(readonly reason: "binary" | "tooBig" | "encoding" | "lineEndings") {
    super(`not editable: ${reason}`);
  }
}

export interface TextFile {
  text: string;
  etag: string;
  /** every line break was CRLF; the editor shows LF and restores CRLF on save */
  crlf: boolean;
}

/**
 * Fetch a file for the editor: refuses (before reading) anything over `maxEditBytes` by Content-Length, anything
 * with a NUL in its first 8 KiB, and anything that is not valid UTF-8. Returns the ETag to send back as `ifMatch`.
 */
export async function readFileText(id: string, target: FsTarget, path: string, maxEditBytes: number): Promise<TextFile> {
  const res = await fetch(downloadHref(id, target, path), { credentials: "include" });
  if (!res.ok) {
    let parsed: ReturnType<typeof parseApiErrorBody> = { message: res.statusText };
    try {
      parsed = parseApiErrorBody(await res.json(), res.statusText);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, parsed.message, parsed.code, parsed.data);
  }
  const rawLen = res.headers.get("content-length");
  const len = rawLen === null ? NaN : Number(rawLen); // a missing header must NOT read as 0 bytes
  if (!Number.isFinite(len) || len > maxEditBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new NotEditableError("tooBig");
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxEditBytes) throw new NotEditableError("tooBig");
  const d = decodeForEdit(bytes);
  if (!d.ok) throw new NotEditableError(d.reason);
  const etag = (res.headers.get("etag") ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
  const crlf = isCrlfOnly(d.text);
  return { text: crlf ? d.text.replace(/\r\n/g, "\n") : d.text, etag, crlf };
}

// ── error mapping ────────────────────────────────────────────────────────────────────────────────────────────

const KNOWN = new Set([
  "not_found", "exists", "not_dir", "is_dir", "not_regular", "not_empty", "denied", "read_only", "no_space", "too_large",
  "changed", "integrity", "bad_request", "unsupported", "not_configured", "busy", "expired", "not_running", "no_binary",
  "failed", "rate_limited", "capability_not_granted", "agent_too_old", "datastore_running", "deploy_in_progress",
  "unsupported_clustered", "not_deployed",
]);

/** i18n key (under apps.files.err.*) for a failed file call, or null when the raw message should be shown. */
export function fsErrorKey(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const code = err.code === "staging_full" ? "no_space" : err.code;
  if (code && KNOWN.has(code)) return `apps.files.err.${code}`;
  if (err.status === 429) return "apps.files.err.rate_limited";
  if (err.status === 413) return "apps.files.err.too_large";
  return null;
}
