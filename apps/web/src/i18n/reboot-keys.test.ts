import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import reboot from "./locales/en/reboot.json";
import notifications from "./locales/en/notifications.json";

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), "utf8");
const sources = [read("../components/server-reboot-card.tsx"), read("../app/(app)/servers/[id]/page.tsx")].join("\n");

function flatten(o: unknown, prefix = ""): string[] {
  if (typeof o === "string") return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}
const keys = flatten(reboot);

describe("reboot i18n coverage", () => {
  it("every literal reboot.* key the UI references exists in reboot.json", () => {
    const used = [...sources.matchAll(/["'`]reboot\.([A-Za-z0-9_.]+)["'`]/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(20);
    for (const k of used) expect(keys, k).toContain(k);
  });

  it("every key built dynamically has all its members (verdicts, reasons, steps, hints, results, schedule errors)", () => {
    const need: Record<string, string[]> = {
      "verdict.container": ["ok", "missing", "unhealthy", "pending", "skipped"],
      "verdict.domain": ["ok", "not_answering", "not_answering_before", "pending", "unverified"],
      "report.result": ["ok", "degraded", "failed", "cancelled"],
      "live.step": ["scheduled", "rebooting", "waiting", "verifying"],
      "live.hint": ["scheduled", "rebooting", "waiting", "verifying"],
      scheduleError: ["invalid", "past", "tooFar"],
      reason: ["snapshot_failed", "agent_offline", "busy_patch", "busy_deploy", "unsupported", "start_failed", "interrupted", "host_did_not_reboot", "agent_never_returned", "docker_inactive", "state_unreadable", "missed", "unauthorized"],
    };
    for (const [prefix, members] of Object.entries(need)) for (const m of members) expect(keys, `${prefix}.${m}`).toContain(`${prefix}.${m}`);
  });

  it("every key in reboot.json is used somewhere (no dead strings)", () => {
    const dynamicPrefixes = ["verdict.", "reason.", "live.step.", "live.hint.", "report.result.", "scheduleError."];
    for (const k of keys) {
      if (dynamicPrefixes.some((p) => k.startsWith(p))) continue;
      expect(sources, k).toContain(`reboot.${k}`);
    }
  });

  it("the placeholders the code passes are in the strings", () => {
    expect(reboot.dialog.impact).toContain("{containers}");
    expect(reboot.dialog.impact).toContain("{domains}");
    expect(reboot.dialog.typeToConfirm).toContain("{name}");
    expect(reboot.live.scheduledFor).toContain("{when}");
    expect(reboot.report.summary).toMatch(/\{containersOk\}.*\{containersTotal\}.*\{domainsOk\}.*\{domainsTotal\}/);
  });

  it("the three reboot notification events have labels", () => {
    for (const k of ["eventServerRebootVerified", "eventServerRebootDegraded", "eventServerRebootFailed"]) expect(typeof (notifications as Record<string, unknown>)[k], k).toBe("string");
  });
});
