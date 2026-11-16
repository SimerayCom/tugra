import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import locale from "./locales/en/migrationRun.json";

const runbook = readFileSync(path.resolve(__dirname, "../../../../docs/runbooks/guided-migration.md"), "utf8").replace(/\s+/g, " ");
const safety = locale.safety as Record<string, string>;
const codes = locale.codes as Record<string, string>;

/** What the hub does (baseline/workers.ts): a job-runner mark holds only an app WITHOUT a domain; on an app that serves a
 *  domain it is a conflict that fails PREFLIGHT and DEPLOY_DARK; a mark that names no app of the plan fails them too. */
describe("worker-mark wording matches the hub", () => {
  it("the card never says a job-runner mark holds an app that serves a domain", () => {
    expect(safety.marksHint).not.toMatch(/serves a domain as a job runner to hold it/i);
    expect(safety.marksHint).toMatch(/no domain/i);
    expect(safety.marksHint).toMatch(/refused/i);
    expect(safety.roleJobRunner).toMatch(/no domain/i);
  });
  it("the runbook says the same", () => {
    expect(runbook).not.toMatch(/a job runner that serves a domain is held too/i);
    expect(runbook).toMatch(/job-runner. mark on an app that \*\*serves a domain\*\* holds nothing/);
    expect(runbook).toMatch(/matches no app of the plan also fails PREFLIGHT/);
  });
  it("the unmatched-mark failures are worded", () => {
    expect(codes["preflight_worker-mark-unmatched"]).toBeTruthy();
    expect(codes["deploy-dark_worker-mark-unmatched"]).toBeTruthy();
  });
});

describe("an owner input no step reads is not offered", () => {
  it("has no tick-gap wording left in the panel locale or the runbook table", () => {
    expect(JSON.stringify(locale)).not.toMatch(/tickGap|write gap you accept/i);
    expect(runbook).not.toMatch(/\| `tickGapAcceptMinutes` \(0 to 10080\)/);
    expect(runbook).toMatch(/No step reads it yet/);
  });
});
