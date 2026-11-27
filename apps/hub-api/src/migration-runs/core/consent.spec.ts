/**
 * The secret-values consent of an agent session, through the real service and engine over the in-memory world: a real run, a retry, the
 * next run of a campaign and a promotion after the session was renewed all import with the consent the owner gave for the session, or
 * say plainly that it is missing before anything starts and wait for it instead of failing.
 */
import { ConflictException, Logger } from "@nestjs/common";
import { ACTOR, RunWorld } from "./testing/run-world";

jest.setTimeout(30_000);

beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation();
  jest.spyOn(Logger.prototype, "error").mockImplementation();
  jest.spyOn(Logger.prototype, "log").mockImplementation();
});

const AGENT = { applies: true, classes: ["env", "db_credentials"], agentServerId: "srv-coolify" };
const standing = (v: boolean) => ({ ...AGENT, standing: v });

describe("a real run on an agent session needs the owner's consent before it starts", () => {
  it("refuses to create a real run while the consent does not stand, with its code, and creates nothing", async () => {
    const w = new RunWorld();
    w.port.consent = standing(false);
    const err = await w.create({ dryRun: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toBe("consent-required");
    expect(w.store.runs.size).toBe(0);
  });

  it("creates it once the consent stands, and never asks for a dry run (it applies nothing)", async () => {
    const w = new RunWorld();
    w.port.consent = standing(false);
    await expect(w.create({ dryRun: true })).resolves.toBeTruthy();
    w.port.consent = standing(true);
    await expect(w.create({ dryRun: false })).resolves.toBeTruthy();
  });

  it("a session with no such consent to give (a token session) is never asked", async () => {
    const w = new RunWorld();
    w.port.consent = { applies: false, standing: false, classes: [], agentServerId: null };
    await expect(w.create({ dryRun: false })).resolves.toBeTruthy();
  });

  it("refuses to start a queued run whose consent ran out since it was made, and starts it after it is given again", async () => {
    const w = new RunWorld();
    w.port.consent = standing(true);
    const id = await w.create({ dryRun: false });
    w.port.consent = standing(false);
    await expect(w.service.start(ACTOR, id, {})).rejects.toThrow("consent-required");
    expect(w.status(id)).toBe("QUEUED");
    w.port.consent = standing(true);
    await w.service.start(ACTOR, id, {});
    expect(w.status(id)).toBe("RUNNING");
  });

  it("promotes a finished dry run only with the consent of the session it uses: a renewed session starts without it", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    await w.acceptWarnings(d);
    // the 1-hour session ended; the owner reconnected through the agent and got a new session that holds no consent yet
    w.env.sessions.set("s2", { ...w.env.session0("s2") });
    w.port.consent = standing(false);
    await expect(w.service.start(ACTOR, d, { sessionId: "s2" })).rejects.toThrow("consent-required");
    expect(w.status(d)).toBe("DRY_RUN_DONE");
    expect(w.store.runs.size).toBe(1); // no run was created
    w.port.consent = standing(true);
    const promoted = await w.service.start(ACTOR, d, { sessionId: "s2" });
    expect(promoted.promotedFromId).toBe(d);
  });
});

describe("what the run page asks: does the consent stand for the session this run uses", () => {
  it("answers for the run's own session, or the renewed one the screen made, classes only", async () => {
    const w = new RunWorld();
    w.port.consent = standing(true);
    const id = await w.create({ dryRun: false });
    expect(await w.service.secretsConsent(ACTOR, id, {})).toEqual({ applies: true, standing: true, classes: ["env", "db_credentials"], sessionId: "s1", serverId: "srv-coolify" });
    w.env.sessions.set("s2", w.env.session0("s2"));
    w.port.consent = standing(false);
    expect(await w.service.secretsConsent(ACTOR, id, { sessionId: "s2" })).toMatchObject({ applies: true, standing: false, sessionId: "s2" });
    expect(w.port.consentCalls.at(-1)).toEqual({ sessionId: "s2" });
  });

  it("does not apply to a session that is gone or to another source's session", async () => {
    const w = new RunWorld();
    w.port.consent = standing(true);
    const id = await w.create({ dryRun: false });
    expect(await w.service.secretsConsent(ACTOR, id, { sessionId: "ghost" })).toMatchObject({ applies: false, standing: false, sessionId: null });
    w.env.sessions.set("sd", { ...w.env.session0("sd"), sourceKind: "dokploy" });
    expect(await w.service.secretsConsent(ACTOR, id, { sessionId: "sd" })).toMatchObject({ applies: false });
  });

  it("is the actor's own run only (a stranger gets a 404)", async () => {
    const w = new RunWorld();
    const id = await w.create({ dryRun: true });
    await expect(w.service.secretsConsent({ ...ACTOR, userId: "u2" }, id, {})).rejects.toThrow(/run-not-found/);
  });
});

describe("the consent follows the run's life", () => {
  it("the IMPORT step waits for the consent (the owner can give it on the run page) instead of failing with a code nobody can fix", async () => {
    const w = new RunWorld();
    let id = "";
    // the consent stands while the run is made and started, then ends before IMPORT (it ran out, or another owner's replaced it)
    w.port.consent = standing(true);
    w.port.consentState = async () => ({ ...AGENT, standing: !id || w.stepStatus(id, "PREFLIGHT") !== "PASSED" });
    id = await w.create({ dryRun: false });
    await w.start(id);
    await w.settle(id);
    const v = await w.view(id);
    expect(v.nextAction).toMatchObject({ stepKey: "IMPORT", code: "import.consent-required" });
    expect(w.status(id)).toBe("WAITING");
    expect(w.port.calls.filter((c) => c === "apply")).toHaveLength(0);

    // the owner allows it on the run page: the next pass continues by itself
    w.port.consentState = async () => ({ ...AGENT, standing: true });
    await w.tick(2);
    await w.settle(id);
    expect(w.port.calls.filter((c) => c === "apply")).toHaveLength(1);
    expect(w.status(id)).toBe("COMPLETED");
  });

  it("PREFLIGHT says it too when the consent ended between the start and the first check (a failing check, the run waits, nothing is touched)", async () => {
    const w = new RunWorld();
    w.port.consent = standing(true);
    const id = await w.create({ dryRun: false });
    w.port.consentState = async () => ({ ...AGENT, standing: false });
    // started by the engine directly: the start call would refuse, and this is the lapse between the two
    await w.store.updateRun(id, { statusIn: ["QUEUED"] }, { status: "RUNNING" });
    await w.settle(id);
    const v = await w.view(id);
    expect(v.steps.find((s) => s.key === "PREFLIGHT")!.gate?.checks.find((c) => c.id === "preflight.consent")).toMatchObject({ status: "fail", code: "preflight.consent-required" });
    expect(w.port.calls.filter((c) => c === "apply")).toHaveLength(0);
  });

  it("a finished real run hands its session back (the last run ends the consent); a finished dry run does not", async () => {
    const w = new RunWorld();
    const d = await w.create({ dryRun: true });
    await w.settle(d);
    expect(w.port.released).toEqual([]);
    const id = await w.run({ dryRun: false });
    expect(w.status(id)).toBe("COMPLETED");
    expect(w.port.released).toEqual(["s1"]);
  });
});
