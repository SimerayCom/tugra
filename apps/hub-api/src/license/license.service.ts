import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPublicKey, type KeyObject } from "node:crypto";
import { jwtVerify } from "jose";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { currentEdition, normalizeEdition, setLicensedEdition, type Edition } from "../common/edition";
import { TUGRA_LICENSE_PUBLIC_KEY } from "./license-key";

export type LicenseSource = "db" | "env";

export interface LicenseStatusView {
  /** The effective edition the instance runs as (env signal raised by a valid license). */
  plan: string;
  /** Whether a currently-valid signed license is driving/raising the edition. */
  valid: boolean;
  /** License expiry (ISO) when a valid license is active, else null. */
  expiresAt: string | null;
  /** Where the (valid or attempted) license token came from, or null when none is present. */
  source: LicenseSource | null;
}

/**
 * Signed-license entitlement. Verifies a Tugra-issued EdDSA (ed25519) JWT license and unlocks the granted
 * edition. The license is created by Tugra's proprietary billing service (outside this repo) after payment;
 * the OSS core only VERIFIES it — mirroring how the self-update manifest is signature-verified. Because the
 * token is signature-protected, storing it in the DB (owner-pasted) is safe: an operator cannot forge an
 * entitlement, so the "edition is not a runtime toggle" guarantee holds.
 */
@Injectable()
export class LicenseService implements OnModuleInit {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: InstanceSettingsService,
  ) {}

  private cachedKey: KeyObject | null = null;
  // The last verified-valid license (null when none/invalid), plus where a token was last found (so the
  // owner UI can say "your token didn't verify" rather than "no license").
  private state: { edition: Edition; expiresAt: number; source: LicenseSource } | null = null;
  private lastSource: LicenseSource | null = null;

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /**
   * The base64 ed25519 SPKI license public key. In production this is ONLY the compiled-in trust anchor
   * (TUGRA_LICENSE_PUBLIC_KEY) — the env is deliberately ignored so an operator can't substitute their own
   * key and self-sign. A dev/test env override (TUGRA_LICENSE_PUBLISHER_KEY) exists purely for local
   * testing (jest sets NODE_ENV=test). No key configured → community edition.
   */
  private keyB64(): string | undefined {
    const lenient = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
    if (lenient) {
      const override = this.config.get<string>("TUGRA_LICENSE_PUBLISHER_KEY");
      if (override) return override;
    }
    return TUGRA_LICENSE_PUBLIC_KEY || undefined;
  }

  /** Tugra's ed25519 license public key as a KeyObject, or null when licensing is unconfigured. */
  private publisherKey(): KeyObject | null {
    const b64 = this.keyB64();
    if (!b64) return null;
    if (!this.cachedKey) {
      this.cachedKey = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    }
    return this.cachedKey;
  }

  /**
   * Verify a license token: ed25519 signature (alg pinned to EdDSA — no alg-confusion/`none`), a required
   * expiry (jose rejects an expired token), and a paid edition claim. Throws on any failure; the caller
   * (boot refresh + PATCH) treats a throw as "no entitlement".
   */
  async verifyToken(token: string): Promise<{ edition: Edition; expiresAt: number }> {
    const key = this.publisherKey();
    if (!key) throw new Error("licensing is not configured on this server");
    const { payload } = await jwtVerify(token, key, { algorithms: ["EdDSA"] });
    if (typeof payload.exp !== "number") throw new Error("license has no expiry");
    const edition = normalizeEdition(typeof payload.edition === "string" ? payload.edition : undefined);
    if (edition === "community") throw new Error("license does not grant a paid edition");
    return { edition, expiresAt: payload.exp * 1000 };
  }

  /** Re-load the license and update the cached edition. Candidate tokens are tried in precedence order —
   *  the owner-pasted DB token first, then the TUGRA_LICENSE env fallback — so a DB token that has since
   *  lapsed does NOT mask a still-valid env fallback license. Never throws: an unconfigured/absent/invalid
   *  license simply clears the entitlement (community/env edition). */
  async refresh(): Promise<void> {
    const candidates: Array<{ token: string; source: LicenseSource }> = [];
    try {
      const s = await this.settings.get();
      if (s.licenseToken) candidates.push({ token: s.licenseToken, source: "db" });
    } catch {
      // Settings/DB unavailable (e.g. early boot) — skip the DB candidate.
    }
    const envToken = this.config.get<string>("TUGRA_LICENSE");
    if (envToken) candidates.push({ token: envToken, source: "env" });

    if (candidates.length === 0) {
      setLicensedEdition(null);
      this.state = null;
      this.lastSource = null;
      return;
    }
    this.lastSource = candidates[0].source; // the primary token's origin (for the owner UI when none verify)
    for (const c of candidates) {
      try {
        const { edition, expiresAt } = await this.verifyToken(c.token);
        setLicensedEdition({ edition, expiresAt });
        this.state = { edition, expiresAt, source: c.source };
        this.lastSource = c.source;
        return;
      } catch {
        // This candidate didn't verify — try the next one.
      }
    }
    // No candidate verified — grant nothing.
    setLicensedEdition(null);
    this.state = null;
  }

  status(): LicenseStatusView {
    const valid = !!(this.state && this.state.expiresAt > Date.now());
    return {
      plan: currentEdition(),
      valid,
      expiresAt: valid ? new Date(this.state!.expiresAt).toISOString() : null,
      source: valid ? this.state!.source : this.lastSource,
    };
  }
}
