import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TemplateCatalogService } from "./template-catalog.service";
import { CatalogVerifyError, MAX_ENVELOPE_BYTES, verifyCatalogEnvelope } from "./catalog-envelope";

export type SyncResult =
  | { status: "unconfigured" }
  | { status: "ok"; version: string; templateCount: number }
  | { status: "error"; reason: string };

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch → verify → persist → apply the signed remote catalog. NEVER throws: on any failure it leaves
 * the current in-memory snapshot untouched (offline fallback never blanks the gallery). The signature
 * (pinned publisher key) is the trust boundary; the URL is admin-set config.
 */
@Injectable()
export class CatalogSyncRunnerService {
  private readonly logger = new Logger(CatalogSyncRunnerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly catalog: TemplateCatalogService,
  ) {}

  async sync(): Promise<SyncResult> {
    const url = this.config.get<string>("CATALOG_SOURCE_URL");
    const key = this.config.get<string>("CATALOG_PUBLISHER_KEY");
    if (!url || !key) return { status: "unconfigured" }; // opt-in: never fetch, never touch the snapshot

    let body: string;
    try {
      body = await this.fetchBody(url);
    } catch (e) {
      return this.fail("fetch", e);
    }

    let verified: { version: string; templates: Record<string, unknown> };
    try {
      verified = verifyCatalogEnvelope(body, key) as { version: string; templates: Record<string, unknown> };
    } catch (e) {
      return this.fail(e instanceof CatalogVerifyError ? e.reason : "verify", e);
    }

    const count = Object.keys(verified.templates).length;
    try {
      // Persist BEFORE applying so a crash between the two still leaves a durable good row for boot.
      const payload = { version: verified.version, templates: verified.templates } as unknown as Prisma.InputJsonValue;
      const now = new Date();
      const data = { version: verified.version, sourceUrl: url, payload, templateCount: count, signatureVerifiedAt: now, fetchedAt: now };
      await this.prisma.catalogSnapshot.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", ...data },
        update: data,
      });
    } catch (e) {
      return this.fail("persist", e);
    }

    this.catalog.applyRemote(verified.templates as Parameters<TemplateCatalogService["applyRemote"]>[0]);
    this.logger.log(`synced remote catalog v${verified.version} (${count} templates)`);
    return { status: "ok", version: verified.version, templateCount: count };
  }

  private async fetchBody(url: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_ENVELOPE_BYTES) throw new Error("body too large");
      if (!res.body) return "";
      // Stream + cap: abort as soon as the accumulated body exceeds the limit, so a response that
      // omits or lies about Content-Length can never buffer past MAX_ENVELOPE_BYTES into memory
      // (res.text() would buffer the whole body first — the cap must bound the read itself).
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_ENVELOPE_BYTES) {
          ctrl.abort();
          throw new Error("body too large");
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(reason: string, e: unknown): SyncResult {
    this.logger.warn(`catalog sync failed (${reason}) — keeping current catalog: ${String((e as Error)?.message ?? e)}`);
    return { status: "error", reason };
  }
}
