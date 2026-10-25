import { Injectable } from "@nestjs/common";
import { InstanceSettings, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { currentEdition, editionAtLeast } from "../common/edition";

const SINGLETON = "singleton";

/** Public white-label view. All null + hidePoweredBy=false means "show the Tugra defaults". */
export interface BrandingView {
  name: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  accentColor: string | null;
  hidePoweredBy: boolean;
}

const TUGRA_DEFAULTS: BrandingView = { name: null, logoUrl: null, faviconUrl: null, accentColor: null, hidePoweredBy: false };

/**
 * The single-row instance-level settings (onboarding state, registration gating, edition, self-update,
 * API gating). Mirrors the CatalogSnapshot fixed-PK singleton pattern. The row is created lazily on first
 * access; `get()` is read-only in steady state (no write per call), so per-request consumers (e.g. API
 * gating) don't cause write amplification.
 */
@Injectable()
export class InstanceSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The singleton settings row, created on first access. Read-only once it exists; race-safe. */
  async get(): Promise<InstanceSettings> {
    const existing = await this.prisma.instanceSettings.findUnique({ where: { id: SINGLETON } });
    if (existing) return existing;
    // First access (or a concurrent race): create it. `update: {}` makes the losing racer a no-op.
    return this.prisma.instanceSettings.upsert({ where: { id: SINGLETON }, create: { id: SINGLETON }, update: {} });
  }

  /** Patch the singleton (ensuring it exists first). Used by onboarding / registration-gating / settings. */
  async update(patch: Prisma.InstanceSettingsUpdateInput): Promise<InstanceSettings> {
    await this.get();
    return this.prisma.instanceSettings.update({ where: { id: SINGLETON }, data: patch });
  }

  /**
   * The effective white-label branding, safe to expose publicly (login page themes pre-auth). Branding is a
   * PRO feature, so it is applied ONLY while the instance is Pro+ — a Community or lapsed-license instance
   * always gets the Tugra defaults, which is what enforces the paywall at read time (a stored brand can't
   * keep applying after a license lapses, and can't be set at all below Pro since the PATCH is gated too).
   */
  async effectiveBranding(): Promise<BrandingView> {
    if (!editionAtLeast(currentEdition(), "pro")) return TUGRA_DEFAULTS;
    const s = await this.get();
    return {
      name: s.brandName,
      logoUrl: s.brandLogoUrl,
      faviconUrl: s.brandFaviconUrl,
      accentColor: s.brandAccentColor,
      hidePoweredBy: s.brandHidePoweredBy,
    };
  }
}
