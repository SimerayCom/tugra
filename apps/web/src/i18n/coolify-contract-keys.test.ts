import { describe, it, expect } from "vitest";
import {
  AGENT_CAPABILITIES,
  CAMPAIGN_STATUSES,
  CLEANUP_STATUSES,
  COMPLETENESS_KINDS,
  COOLIFY_RUN_CAPABILITIES,
  COOLIFY_SECRET_CLASSES,
  COOLIFY_SECRET_WIRE_CODES,
  COOLIFY_SSH_RESULT_CODES,
  COOLIFY_SSH_TARGET_STATES,
  HOST_EVIDENCE_KINDS,
  PLACEMENT_FAILURE_CODES,
  PLACEMENT_KINDS,
  PLACEMENT_LOCK_REASONS,
  PROJECT_MOVE_PHASES,
  REMNANT_KINDS,
  TAKEOVER_CERT_STATES,
  TAKEOVER_FAILURE_CODES,
  TAKEOVER_ISSUES,
  TAKEOVER_STATUSES,
} from "@tugra/shared";
import en from "./locales/en";
import { translate } from "./translate";

const text = (key: string): unknown => translate(en as Record<string, unknown>, key);
const present = (prefix: string, names: readonly string[]) => names.filter((n) => text(`${prefix}.${n}`) === `${prefix}.${n}`);

const NAMESPACES = ["coolifyAgent", "coolifySecrets", "coolifyInstall", "hostMatch", "placement", "coolifyInPlace", "coolifyCleanup", "projectMove"] as const;

/** The strings each takeover lane's screens will use, for every code the hub and the agent can answer with. A new code without a line fails here. */
describe("Coolify takeover i18n contract", () => {
  it("registers every lane's namespace with a title and a subtitle", () => {
    for (const ns of NAMESPACES) {
      expect(typeof (en as Record<string, Record<string, unknown>>)[ns], ns).toBe("object");
      expect(text(`${ns}.title`)).not.toBe(`${ns}.title`);
      expect(text(`${ns}.subtitle`)).not.toBe(`${ns}.subtitle`);
    }
  });

  it("has a line for every shared code, state and kind", () => {
    expect(present("coolifySecrets.class", COOLIFY_SECRET_CLASSES)).toEqual([]);
    expect(present("coolifySecrets.wire", COOLIFY_SECRET_WIRE_CODES.filter((c) => c !== "ok"))).toEqual([]);
    expect(present("coolifyInstall.code", COOLIFY_SSH_RESULT_CODES)).toEqual([]);
    expect(present("coolifyInstall.state", COOLIFY_SSH_TARGET_STATES)).toEqual([]);
    expect(present("hostMatch.evidence", HOST_EVIDENCE_KINDS)).toEqual([]);
    expect(present("hostMatch.status", ["certain", "probable", "ambiguous", "none"])).toEqual([]);
    expect(present("placement.kind", PLACEMENT_KINDS)).toEqual([]);
    expect(present("placement.lock", PLACEMENT_LOCK_REASONS)).toEqual([]);
    expect(present("placement.campaign.status", CAMPAIGN_STATUSES)).toEqual([]);
    expect(present("coolifyInPlace.status", TAKEOVER_STATUSES)).toEqual([]);
    expect(present("coolifyInPlace.cert", TAKEOVER_CERT_STATES)).toEqual([]);
    expect(present("coolifyInPlace.issue", TAKEOVER_ISSUES)).toEqual([]);
    expect(present("coolifyInPlace.failure", TAKEOVER_FAILURE_CODES)).toEqual([]);
    expect(present("coolifyInPlace.hint", TAKEOVER_STATUSES)).toEqual([]);
    expect(present("coolifyInPlace.check", ["pending", "ok", "failed"])).toEqual([]);
    expect(present("coolifyInPlace.action", ["plan", "test", "swap", "verify", "giveBack"])).toEqual([]);
    expect(present("placement.failure", PLACEMENT_FAILURE_CODES)).toEqual([]);
    expect(present("coolifyCleanup.status", CLEANUP_STATUSES)).toEqual([]);
    expect(present("coolifyCleanup.kind", COMPLETENESS_KINDS)).toEqual([]);
    expect(present("coolifyCleanup.remnant", REMNANT_KINDS)).toEqual([]);
    expect(present("projectMove.phase", PROJECT_MOVE_PHASES)).toEqual([]);
  });

  it("labels the new capabilities (long and short) and the secret tiers", () => {
    for (const c of COOLIFY_RUN_CAPABILITIES) {
      expect(typeof text(`servers.cap_${c}`), c).toBe("string");
      expect(text(`servers.cap_${c}`)).not.toBe(`servers.cap_${c}`);
      expect(text(`servers.capShort_${c}`)).not.toBe(`servers.capShort_${c}`);
    }
    expect(present("coolifySecrets.tier", ["T1", "T2"])).toEqual([]);
  });

  it("every capability the hub can grant has a label, so a granted one never renders as a raw key", () => {
    const unlabeled = AGENT_CAPABILITIES.filter((c) => text(`servers.cap_${c}`) === `servers.cap_${c}`);
    expect(unlabeled).toEqual([]);
  });

  it("is English text only, never empty and never a bare key", () => {
    const walk = (node: unknown, trail: string, out: string[]) => {
      if (typeof node === "string") {
        if (!node.trim() || /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(node)) out.push(trail);
      } else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, `${trail}.${k}`, out);
    };
    const bad: string[] = [];
    for (const ns of NAMESPACES) walk((en as Record<string, unknown>)[ns], ns, bad);
    expect(bad).toEqual([]);
  });

  it("never promises that nothing is sent when secrets are read: the consent line names what is never read", () => {
    expect(String(text("coolifySecrets.consent.neverRead"))).toMatch(/encryption key/i);
    expect(String(text("coolifySecrets.consent.neverRead"))).toMatch(/SSH private keys/i);
  });
});
