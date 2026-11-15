import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ApiError } from "./api";
import { NotEditableError, UploadAbortedError, downloadHref, filesApi, fsErrorKey, readFileText, uploadFile, uploadUrl, type FsTarget } from "./files-api";

const vol: FsTarget = { scope: "volume", name: "data" };
const ctr: FsTarget = { scope: "container", name: "tugra_a1" };

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("filesApi (JSON calls)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockFetch(res: () => Response) {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => res());
    vi.stubGlobal("fetch", f);
    return f;
  }
  const body = (f: ReturnType<typeof mockFetch>) => JSON.parse(String(f.mock.calls[0][1]?.body));

  it("addresses volumes and containers on their own routes, with the right target key", async () => {
    const f = mockFetch(() => jsonRes(200, {}));
    await filesApi.statFile("a1", vol, "d/f");
    expect(f.mock.calls[0][0]).toBe("/api/v1/apps/a1/files/stat?volume=data&path=d%2Ff");
    await filesApi.statFile("a1", ctr, "/app/x");
    expect(f.mock.calls[1][0]).toBe("/api/v1/apps/a1/container-files/stat?container=tugra_a1&path=%2Fapp%2Fx");
    await filesApi.listContainerFiles("a1", "tugra_a1", "/etc");
    expect(f.mock.calls[2][0]).toBe("/api/v1/apps/a1/container-files?container=tugra_a1&path=%2Fetc");
    await filesApi.filesMeta("a1");
    expect(f.mock.calls[3][0]).toBe("/api/v1/apps/a1/files/meta");
  });

  it("omits an empty container name (a single-container app) rather than sending container=", async () => {
    const f = mockFetch(() => jsonRes(200, {}));
    await filesApi.listContainerFiles("a1", "", "/app");
    expect(f.mock.calls[0][0]).toBe("/api/v1/apps/a1/container-files?path=%2Fapp");
  });

  it("sends mkdir/rename/chmod bodies and delete query exactly as the hub's strict DTOs expect", async () => {
    const f = mockFetch(() => jsonRes(200, {}));
    await filesApi.mkdir("a1", vol, "a/b", { mode: "0755", parents: true, acknowledgeRisk: true });
    expect(f.mock.calls[0][0]).toBe("/api/v1/apps/a1/files/mkdir");
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    expect(body(f)).toEqual({ volume: "data", path: "a/b", mode: "0755", parents: true, acknowledgeRisk: true });
    await filesApi.rename("a1", vol, "a", "b");
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ volume: "data", from: "a", to: "b" });
    await filesApi.chmod("a1", vol, "a", "0600", { acknowledgeRisk: true });
    expect(JSON.parse(String(f.mock.calls[2][1]?.body))).toEqual({ volume: "data", path: "a", mode: "0600", acknowledgeRisk: true });
  });

  it("never sends acknowledgeRisk for the container scope (the hub's DTO rejects the key)", async () => {
    const f = mockFetch(() => jsonRes(200, {}));
    await filesApi.mkdir("a1", ctr, "/app/d", { acknowledgeRisk: true });
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ container: "tugra_a1", path: "/app/d" });
    await filesApi.rename("a1", ctr, "/a", "/b", { acknowledgeRisk: true });
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ container: "tugra_a1", from: "/a", to: "/b" });
    await filesApi.chmod("a1", ctr, "/a", "0644", { acknowledgeRisk: true });
    expect(JSON.parse(String(f.mock.calls[2][1]?.body))).toEqual({ container: "tugra_a1", path: "/a", mode: "0644" });
    await filesApi.deleteEntry("a1", ctr, "/a", { recursive: true, acknowledgeRisk: true });
    expect(f.mock.calls[3][0]).toBe("/api/v1/apps/a1/container-files?container=tugra_a1&path=%2Fa&recursive=1");
  });

  it("delete uses DELETE with recursive/acknowledgeRisk as 0|1 query flags, and a 204 resolves", async () => {
    const f = mockFetch(() => new Response(null, { status: 204 }));
    await expect(filesApi.deleteEntry("a1", vol, "d", { recursive: true, acknowledgeRisk: true })).resolves.toBeUndefined();
    expect(f.mock.calls[0][0]).toBe("/api/v1/apps/a1/files?volume=data&path=d&recursive=1&acknowledgeRisk=1");
    expect(f.mock.calls[0][1]?.method).toBe("DELETE");
    await filesApi.deleteEntry("a1", vol, "d");
    expect(f.mock.calls[1][0]).toBe("/api/v1/apps/a1/files?volume=data&path=d");
  });

  it("surfaces the hub's machine code and body on ApiError", async () => {
    mockFetch(() => jsonRes(409, { statusCode: 409, code: "datastore_running", message: "risky" }));
    const e = await filesApi.mkdir("a1", vol, "d").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(409);
    expect((e as ApiError).code).toBe("datastore_running");
    expect((e as ApiError).message).toBe("risky");
    expect((e as ApiError).data).toMatchObject({ code: "datastore_running" });
    mockFetch(() => jsonRes(403, { statusCode: 403, message: "nope", code: "capability_not_granted", capability: "files_write", serverId: "s1" }));
    const e2 = (await filesApi.mkdir("a1", vol, "d").catch((x: unknown) => x)) as ApiError;
    expect(e2.data?.capability).toBe("files_write");
    mockFetch(() => jsonRes(400, { message: ["a: bad", "b: worse"] }));
    expect(((await filesApi.mkdir("a1", vol, "d").catch((x: unknown) => x)) as ApiError).message).toBe("a: bad, b: worse");
    expect(((await filesApi.mkdir("a1", vol, "d").catch((x: unknown) => x)) as ApiError).code).toBeUndefined();
  });

  it("builds same-origin download links (cookie-authed, no blob)", () => {
    expect(downloadHref("a1", vol, "d/résumé 1.txt")).toBe("/api/v1/apps/a1/files/content?volume=data&path=d%2Fr%C3%A9sum%C3%A9+1.txt");
    expect(downloadHref("a1", ctr, "/etc/hosts")).toBe("/api/v1/apps/a1/container-files/content?container=tugra_a1&path=%2Fetc%2Fhosts");
  });
});

class FakeXHR {
  static instances: FakeXHR[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  withCredentials = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  statusText = "";
  responseText = "";
  sent: unknown;
  constructor() {
    FakeXHR.instances.push(this);
  }
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k.toLowerCase()] = v;
  }
  send(b: unknown) {
    this.sent = b;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body?: unknown) {
    this.status = status;
    this.responseText = body === undefined ? "" : JSON.stringify(body);
    this.onload?.();
  }
}

describe("uploadFile (XHR)", () => {
  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    document.cookie = "tg_csrf=tok123";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = "tg_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  const blob = new Blob(["hello"]);

  it("PUTs the raw body with credentials, the CSRF header and an octet-stream content type", async () => {
    const h = uploadFile({ id: "a1", target: vol, path: "d/f.txt", body: blob, overwrite: true, mode: "0644", ifMatch: "5-1", acknowledgeRisk: true });
    const x = FakeXHR.instances[0];
    expect(x.method).toBe("PUT");
    expect(x.url).toBe("/api/v1/apps/a1/files/content?volume=data&path=d%2Ff.txt&overwrite=1&mode=0644&ifMatch=5-1&acknowledgeRisk=1");
    expect(x.withCredentials).toBe(true);
    expect(x.headers["content-type"]).toBe("application/octet-stream");
    expect(x.headers["x-csrf-token"]).toBe("tok123");
    expect(x.sent).toBe(blob);
    x.respond(201, { path: "d/f.txt", bytes: 5, sha256: "x", etag: "5-9" });
    await expect(h.promise).resolves.toEqual({ path: "d/f.txt", bytes: 5, sha256: "x", etag: "5-9", created: true });
  });

  it("reports 200 as created=false (replaced) and omits the optional params", async () => {
    const h = uploadFile({ id: "a1", target: vol, path: "f", body: blob });
    expect(FakeXHR.instances[0].url).toBe("/api/v1/apps/a1/files/content?volume=data&path=f");
    FakeXHR.instances[0].respond(200, { path: "f", bytes: 5, sha256: "x", etag: "e" });
    expect((await h.promise).created).toBe(false);
  });

  it("container uploads use the container route and never carry acknowledgeRisk", () => {
    expect(uploadUrl({ id: "a1", target: ctr, path: "/app/x", overwrite: true, acknowledgeRisk: true })).toBe(
      "/api/v1/apps/a1/container-files/content?container=tugra_a1&path=%2Fapp%2Fx&overwrite=1",
    );
  });

  it("reports progress as bytes sent and ignores non-computable events", () => {
    const seen: [number, number][] = [];
    uploadFile({ id: "a1", target: vol, path: "f", body: blob, onProgress: (l, t) => seen.push([l, t]) });
    const x = FakeXHR.instances[0];
    x.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 5 });
    x.upload.onprogress?.({ lengthComputable: false, loaded: 3, total: 0 });
    x.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 5 });
    expect(seen).toEqual([[2, 5], [5, 5]]);
  });

  it("maps hub failures to ApiError with their machine code (409 exists, 413, 507, 412, 429)", async () => {
    for (const [status, code] of [[409, "exists"], [413, "too_large"], [507, "staging_full"], [412, "changed"], [429, "rate_limited"], [409, "datastore_running"]] as const) {
      FakeXHR.instances = [];
      const h = uploadFile({ id: "a1", target: vol, path: "f", body: blob });
      FakeXHR.instances[0].respond(status, { statusCode: status, code, message: "m" });
      const e = (await h.promise.catch((x: unknown) => x)) as ApiError;
      expect(e).toBeInstanceOf(ApiError);
      expect({ status: e.status, code: e.code }).toEqual({ status, code });
    }
    // a non-JSON error body still yields an ApiError carrying the status
    FakeXHR.instances = [];
    const h = uploadFile({ id: "a1", target: vol, path: "f", body: blob });
    const x = FakeXHR.instances[0];
    x.statusText = "Bad Gateway";
    x.status = 502;
    x.responseText = "<html>";
    x.onload?.();
    expect(((await h.promise.catch((e: unknown) => e)) as ApiError).status).toBe(502);
  });

  it("abort() cancels the request and rejects with UploadAbortedError", async () => {
    const h = uploadFile({ id: "a1", target: vol, path: "f", body: blob });
    h.abort();
    await expect(h.promise).rejects.toBeInstanceOf(UploadAbortedError);
  });

  it("a network error is an ApiError(0, network)", async () => {
    const h = uploadFile({ id: "a1", target: vol, path: "f", body: blob });
    FakeXHR.instances[0].onerror?.();
    const e = (await h.promise.catch((x: unknown) => x)) as ApiError;
    expect(e.status).toBe(0);
    expect(e.code).toBe("network");
  });

  it("refreshes the session once on a 401 and retries, like apiFetch", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const h = uploadFile({ id: "a1", target: vol, path: "f", body: blob });
    FakeXHR.instances[0].respond(401, { message: "expired" });
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("/api/v1/auth/refresh");
    FakeXHR.instances[1].respond(201, { path: "f", bytes: 5, sha256: "x", etag: "e" });
    await expect(h.promise).resolves.toMatchObject({ created: true });
    // a second 401 is final
    FakeXHR.instances = [];
    const h2 = uploadFile({ id: "a1", target: vol, path: "f", body: blob });
    FakeXHR.instances[0].respond(401, { message: "expired" });
    await vi.waitFor(() => expect(FakeXHR.instances).toHaveLength(2));
    FakeXHR.instances[1].respond(401, { message: "expired" });
    expect(((await h2.promise.catch((e: unknown) => e)) as ApiError).status).toBe(401);
  });
});

describe("readFileText (editor read)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const textRes = (bytes: Uint8Array | string, headers: Record<string, string> = {}) => {
    const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    return new Response(b as BodyInit, { status: 200, headers: { "content-length": String(b.length), etag: '"5-77"', ...headers } });
  };

  it("reads UTF-8 text with its ETag, as a raw credentialed GET of the download URL", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => textRes("hello\n"));
    vi.stubGlobal("fetch", f);
    const r = await readFileText("a1", vol, "n.txt", 1024);
    expect(r).toEqual({ text: "hello\n", etag: "5-77", crlf: false });
    expect(f.mock.calls[0][0]).toBe("/api/v1/apps/a1/files/content?volume=data&path=n.txt");
    expect(f.mock.calls[0][1]).toMatchObject({ credentials: "include" });
  });

  it("shows a CRLF file as LF and remembers to restore it; keeps the trailing newline exactly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textRes("a\r\nb\r\n")));
    expect(await readFileText("a1", vol, "n", 1024)).toMatchObject({ text: "a\nb\n", crlf: true });
    vi.stubGlobal("fetch", vi.fn(async () => textRes("no newline at end")));
    expect((await readFileText("a1", vol, "n", 1024)).text).toBe("no newline at end");
  });

  it("refuses by Content-Length before reading (too big), NUL bytes (binary) and invalid UTF-8", async () => {
    const big = new Response("x", { status: 200, headers: { "content-length": "2048" } });
    const cancel = vi.spyOn(big.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn(async () => big));
    await expect(readFileText("a1", vol, "n", 1024)).rejects.toMatchObject({ reason: "tooBig" });
    expect(cancel).toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => textRes(new Uint8Array([65, 0, 66]))));
    await expect(readFileText("a1", vol, "n", 1024)).rejects.toMatchObject({ reason: "binary" });
    vi.stubGlobal("fetch", vi.fn(async () => textRes(new Uint8Array([0xff, 0xfe, 0x41]))));
    await expect(readFileText("a1", vol, "n", 1024)).rejects.toBeInstanceOf(NotEditableError);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 200 }))); // no Content-Length at all
    await expect(readFileText("a1", vol, "n", 1024)).rejects.toMatchObject({ reason: "tooBig" });
  });

  it("keeps a BOM and refuses mixed line endings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textRes(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))));
    expect((await readFileText("a1", vol, "n", 1024)).text).toBe("\ufeffhi");
    vi.stubGlobal("fetch", vi.fn(async () => textRes("a\r\nb\n")));
    await expect(readFileText("a1", vol, "n", 1024)).rejects.toMatchObject({ reason: "lineEndings" });
  });

  it("surfaces an HTTP error as ApiError with its code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes(409, { statusCode: 409, code: "is_dir", message: "only regular files" })));
    const e = (await readFileText("a1", vol, "d", 1024).catch((x: unknown) => x)) as ApiError;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("is_dir");
  });
});

describe("fsErrorKey", () => {
  it("maps known codes to their apps.files.err.* key and unknown ones to null", () => {
    expect(fsErrorKey(new ApiError(409, "m", "exists"))).toBe("apps.files.err.exists");
    expect(fsErrorKey(new ApiError(412, "m", "changed"))).toBe("apps.files.err.changed");
    expect(fsErrorKey(new ApiError(409, "m", "datastore_running"))).toBe("apps.files.err.datastore_running");
    expect(fsErrorKey(new ApiError(507, "m", "staging_full"))).toBe("apps.files.err.no_space");
    expect(fsErrorKey(new ApiError(429, "m"))).toBe("apps.files.err.rate_limited");
    expect(fsErrorKey(new ApiError(413, "m"))).toBe("apps.files.err.too_large");
    expect(fsErrorKey(new ApiError(500, "m", "weird"))).toBeNull();
    expect(fsErrorKey(new Error("x"))).toBeNull();
    expect(fsErrorKey("boom")).toBeNull();
  });
});
