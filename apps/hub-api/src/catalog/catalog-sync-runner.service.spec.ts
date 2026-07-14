import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { CatalogSyncRunnerService } from "./catalog-sync-runner.service";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "../prisma/prisma.service";
import type { TemplateCatalogService } from "./template-catalog.service";

function keypair(): { priv: KeyObject; pubB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { priv: privateKey, pubB64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}
function signedBody(priv: KeyObject, templates: Record<string, unknown>, version = "1"): string {
  const payload = Buffer.from(JSON.stringify({ version, templates })).toString("base64");
  const sig = sign(null, Buffer.from(payload), priv).toString("base64");
  return JSON.stringify({ payload, sig });
}
const tpl = () => ({ slug: "remote1", name: "Remote", description: "d", category: "tools", composeFile: "services:\n  x:\n    image: y\n" });

function make(over: { url?: string; key?: string; upsert?: jest.Mock; apply?: jest.Mock } = {}) {
  const values: Record<string, unknown> = { CATALOG_SOURCE_URL: over.url, CATALOG_PUBLISHER_KEY: over.key };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  const upsert = over.upsert ?? jest.fn().mockResolvedValue({});
  const prisma = { catalogSnapshot: { upsert } } as unknown as PrismaService;
  const applyRemote = over.apply ?? jest.fn();
  const catalog = { applyRemote } as unknown as TemplateCatalogService;
  return { runner: new CatalogSyncRunnerService(config, prisma, catalog), upsert, applyRemote };
}
// A real Response so `res.body` is a genuine ReadableStream (the runner streams + size-caps the body).
const okResponse = (body: string) => new Response(body, { status: 200 });

describe("CatalogSyncRunnerService", () => {
  const kp = keypair();
  afterEach(() => jest.restoreAllMocks());

  it("no-ops when unconfigured — never fetches, never touches the snapshot", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    const { runner, upsert, applyRemote } = make({});
    expect(await runner.sync()).toEqual({ status: "unconfigured" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(applyRemote).not.toHaveBeenCalled();
  });

  it("happy path: verifies, PERSISTS then APPLIES, returns ok", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(okResponse(signedBody(kp.priv, { remote1: tpl() })));
    const order: string[] = [];
    const upsert = jest.fn().mockImplementation(async () => void order.push("upsert"));
    const apply = jest.fn().mockImplementation(() => void order.push("apply"));
    const { runner } = make({ url: "https://c.example/catalog", key: kp.pubB64, upsert, apply });
    expect(await runner.sync()).toEqual({ status: "ok", version: "1", templateCount: 1 });
    expect(order).toEqual(["upsert", "apply"]); // persist-before-apply (durable on crash)
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "singleton" } }));
  });

  it("bad signature → offline fallback (no persist, no apply, no throw)", async () => {
    const wrong = keypair();
    jest.spyOn(global, "fetch").mockResolvedValue(okResponse(signedBody(kp.priv, { remote1: tpl() })));
    const { runner, upsert, applyRemote } = make({ url: "https://c", key: wrong.pubB64 });
    expect((await runner.sync()).status).toBe("error");
    expect(upsert).not.toHaveBeenCalled();
    expect(applyRemote).not.toHaveBeenCalled();
  });

  it("fetch failure → offline fallback", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network"));
    const { runner, upsert, applyRemote } = make({ url: "https://c", key: kp.pubB64 });
    expect((await runner.sync()).status).toBe("error");
    expect(upsert).not.toHaveBeenCalled();
    expect(applyRemote).not.toHaveBeenCalled();
  });

  it("non-ok HTTP → offline fallback", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const { runner, applyRemote } = make({ url: "https://c", key: kp.pubB64 });
    expect((await runner.sync()).status).toBe("error");
    expect(applyRemote).not.toHaveBeenCalled();
  });

  it("caps an oversize STREAMED body (no content-length) before buffering it all — no persist/apply", async () => {
    // A chunked stream with no Content-Length, totalling > 8MB → the reader must abort past the cap.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1024 * 1024)); // 9 MB > MAX_ENVELOPE_BYTES
        c.close();
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(stream));
    const { runner, upsert, applyRemote } = make({ url: "https://c", key: kp.pubB64 });
    expect((await runner.sync()).status).toBe("error");
    expect(upsert).not.toHaveBeenCalled();
    expect(applyRemote).not.toHaveBeenCalled();
  });

  it("a persist failure aborts before applying (snapshot untouched)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(okResponse(signedBody(kp.priv, { remote1: tpl() })));
    const { runner, applyRemote } = make({ url: "https://c", key: kp.pubB64, upsert: jest.fn().mockRejectedValue(new Error("db")) });
    expect((await runner.sync()).status).toBe("error");
    expect(applyRemote).not.toHaveBeenCalled();
  });
});
