import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { appVersion, isNewer, parseVersion } from "@tugra/shared";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { Prisma } from "@prisma/client";
import { MAX_MANIFEST_BYTES, MAX_SIG_BYTES, UpdateVerifyError, noticeSchema, verifyUpdateManifest } from "./update-manifest";
import type { ChannelEntry, VerifiedManifest } from "./update-manifest";
import type { UpdateNoticeView, UpdateStatusView } from "./dto";

export type CheckResult =
  | { status: "unconfigured" }
  | { status: "ok"; channel: string; current: string; latest: string; updateAvailable: boolean }
  | { status: "error"; reason: string };

/** The full verified channel entry (version + reserved updater fields like minUpgradeFrom). */
export type LatestEntryResult =
  | { status: "unconfigured" }
  | { status: "error"; reason: string }
  | { status: "ok"; channel: string; entry: ChannelEntry };

const FETCH_TIMEOUT_MS = 15_000;

/**
 * The self-update version CHECK. Periodically (via the scheduler) it fetches the signed release manifest,
 * verifies it BEFORE parsing, and caches the latest published version for the instance's channel. It only
 * ever REPORTS — nothing is applied here. `checkRemote` NEVER throws: on any
 * failure it leaves the cached version untouched (offline fallback never blanks the status).
 *
 * Downgrade guard: `updateAvailable` is always `isNewer(latest, appVersion())` against the RUNNING build,
 * so even a validly-signed OLDER manifest reports "no update". `autoUpdate` is surfaced but never acted on.
 */
@Injectable()
export class UpdateService {
  private readonly logger = new Logger(UpdateService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly settings: InstanceSettingsService,
  ) {}

  /** Fetch → verify → cache the latest version for the configured channel. Opt-in; never throws. */
  async checkRemote(): Promise<CheckResult> {
    const url = this.config.get<string>("UPDATE_MANIFEST_URL");
    const key = this.config.get<string>("UPDATE_PUBLISHER_KEY");
    if (!url || !key) return { status: "unconfigured" }; // opt-in: never fetch

    let s: Awaited<ReturnType<InstanceSettingsService["get"]>>;
    try {
      s = await this.settings.get();
    } catch (e) {
      return this.fail("settings", e); // never throw: a transient DB error leaves the cache untouched
    }
    const channel = s.updateChannel || "stable";

    let manifestBody: string;
    let sigBody: string;
    try {
      manifestBody = await this.fetchText(url, MAX_MANIFEST_BYTES);
      sigBody = await this.fetchText(this.sigUrl(url), MAX_SIG_BYTES);
    } catch (e) {
      return this.fail("fetch", e);
    }

    let manifest: VerifiedManifest;
    try {
      manifest = verifyUpdateManifest(manifestBody, sigBody, key);
    } catch (e) {
      return this.fail(e instanceof UpdateVerifyError ? e.reason : "verify", e);
    }

    // Top-level operator notice: independent of the channel entry — persist it (incl. clearing to null) on
    // every successful verify, so a set/clear propagates even when the tracked channel has no entry.
    const cachedNotice = manifest.notice ? (manifest.notice as Prisma.InputJsonValue) : Prisma.JsonNull;

    const entry = manifest.tugra[channel];
    if (!entry) {
      // Non-destructive on the VERSION cache: an unknown/absent channel must not blank a good version.
      this.logger.warn(`update manifest has no entry for channel "${channel}" — keeping cached version`);
      try {
        await this.settings.update({ cachedNotice });
      } catch (e) {
        return this.fail("persist", e);
      }
      const current = appVersion();
      const latest = s.cachedLatestVersion ?? current;
      return { status: "ok", channel, current, latest, updateAvailable: this.available(s.cachedLatestVersion, current) };
    }

    const latest = entry.version;
    // Never cache a version we can't even parse (a signed-but-garbage entry would pollute the status).
    try {
      if (parseVersion(latest)) {
        await this.settings.update({ cachedLatestVersion: latest, cachedNotice });
      } else {
        this.logger.warn(`update manifest channel "${channel}" has an unparseable version — not caching`);
        await this.settings.update({ cachedNotice });
      }
    } catch (e) {
      return this.fail("persist", e); // never throw: a failed write simply leaves the prior cache
    }

    const current = appVersion();
    const updateAvailable = isNewer(latest, current);
    this.logger.log(`update check: channel=${channel} current=${current} latest=${latest} updateAvailable=${updateAvailable}`);
    return { status: "ok", channel, current, latest, updateAvailable };
  }

  /**
   * Fetch + ed25519-verify the manifest FRESH and return the full channel entry (version + minUpgradeFrom
   * + reserved fields). The updater calls this at apply-time so nothing is ever applied from an unverified
   * or stale cache. Never throws — a typed status is returned on any failure (opt-in via UPDATE_MANIFEST_URL).
   */
  async verifyLatestEntry(): Promise<LatestEntryResult> {
    const url = this.config.get<string>("UPDATE_MANIFEST_URL");
    const key = this.config.get<string>("UPDATE_PUBLISHER_KEY");
    if (!url || !key) return { status: "unconfigured" };

    let channel = "stable";
    try {
      channel = (await this.settings.get()).updateChannel || "stable";
    } catch (e) {
      return this.failEntry("settings", e);
    }

    let manifestBody: string;
    let sigBody: string;
    try {
      manifestBody = await this.fetchText(url, MAX_MANIFEST_BYTES);
      sigBody = await this.fetchText(this.sigUrl(url), MAX_SIG_BYTES);
    } catch (e) {
      return this.failEntry("fetch", e);
    }

    let manifest: VerifiedManifest;
    try {
      manifest = verifyUpdateManifest(manifestBody, sigBody, key);
    } catch (e) {
      return this.failEntry(e instanceof UpdateVerifyError ? e.reason : "verify", e);
    }

    const entry = manifest.tugra[channel];
    if (!entry) return this.failEntry("no-channel", new Error(`no manifest entry for channel "${channel}"`));
    return { status: "ok", channel, entry };
  }

  private failEntry(reason: string, e: unknown): LatestEntryResult {
    this.logger.warn(`verifyLatestEntry failed (${reason}): ${String((e as Error)?.message ?? e)}`);
    return { status: "error", reason };
  }

  /** Owner-facing status. Reads ONLY the cache + running version — never triggers a remote fetch. */
  async getStatus(): Promise<UpdateStatusView> {
    const s = await this.settings.get();
    const current = appVersion();
    const latest = s.cachedLatestVersion ?? null;
    return {
      current,
      latest,
      channel: s.updateChannel || "stable",
      updateAvailable: this.available(latest, current),
      changelogUrl: this.config.get<string>("UPDATE_CHANGELOG_URL") ?? null,
      autoUpdate: s.autoUpdate,
      notice: this.liveNotice(s.cachedNotice),
    };
  }

  private available(latest: string | null | undefined, current: string): boolean {
    return !!latest && isNewer(latest, current);
  }

  /** Validate the cached notice Json against the signed schema and drop it if malformed or expired. */
  private liveNotice(cached: unknown): UpdateNoticeView | null {
    const parsed = noticeSchema.safeParse(cached);
    if (!parsed.success) return null;
    const n = parsed.data;
    if (n.expiresAt && Date.parse(n.expiresAt) <= Date.now()) return null; // expired → drop
    return { id: n.id, message: n.message, severity: n.severity, url: n.url ?? null };
  }

  /** versions.json → versions.json.sig — the installer derives the sig URL the same way. */
  private sigUrl(url: string): string {
    return `${url}.sig`;
  }

  /**
   * Streaming, size-capped fetch (mirrors the catalog runner). The URL is admin/env config (not user
   * input) so no SSRF guard is needed — and a redirect to an internal host could never produce a valid
   * signature anyway. The cap bounds the READ itself (a lying/absent Content-Length can't buffer past it).
   */
  private async fetchText(url: string, maxBytes: number): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error("body too large");
      if (!res.body) return "";
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
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

  private fail(reason: string, e: unknown): CheckResult {
    this.logger.warn(`update check failed (${reason}) — keeping cached version: ${String((e as Error)?.message ?? e)}`);
    return { status: "error", reason };
  }
}
