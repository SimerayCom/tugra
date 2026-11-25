import { ForbiddenException } from "@nestjs/common";
import { AgentCommandTimeoutException, AgentDisconnectedException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { checkEnrolled, clampPerHost, codeOfError, decideProbe, isActiveState, Semaphore, useSudoFor } from "./coolify-ssh-plan";

describe("decideProbe", () => {
  it("leaves a server that already runs an agent alone", () => {
    expect(decideProbe({ ok: true, code: "skipped_present" })).toEqual({ state: "SKIPPED_PRESENT", code: "skipped_present" });
    expect(decideProbe({ ok: true, code: "skipped_foreign" })).toEqual({ state: "SKIPPED_FOREIGN", code: "skipped_foreign" });
  });
  it("is READY only for a probe that says nothing is in the way", () => {
    expect(decideProbe({ ok: true, code: "ok_installed" })).toEqual({ state: "READY", code: null });
  });
  it("fails with the agent's own code, whatever the facts", () => {
    for (const code of ["needs_root", "hub_unreachable_from_target", "auth_failed", "hostkey_changed"] as const) {
      expect(decideProbe({ ok: false, code, probe: { agent: "none" } })).toEqual({ state: "FAILED", code });
    }
  });
  it("never reads a failed probe as READY even if it says skipped_*", () => {
    expect(decideProbe({ ok: false, code: "skipped_present" }).state).toBe("FAILED");
  });
});

describe("useSudoFor", () => {
  it("is false for root and for a Docker-group user, true otherwise", () => {
    expect(useSudoFor({ uid: 0, dockerAccess: true })).toBe(false);
    expect(useSudoFor({ uid: 0 })).toBe(false);
    expect(useSudoFor({ uid: 1000, dockerAccess: true })).toBe(false);
    expect(useSudoFor({ uid: 1000, dockerAccess: false, sudoNoPassword: true })).toBe(true);
    expect(useSudoFor({ uid: 1000 })).toBe(true);
    expect(useSudoFor(null)).toBe(false);
  });
});

describe("checkEnrolled", () => {
  const base = { probedFp: "SHA256:" + "A".repeat(43), reportedFp: null as string | null, coolifyAddress: "203.0.113.7", reportedAddresses: [] as string[] };
  it("matches by fingerprint when the agent reports one", () => {
    expect(checkEnrolled({ ...base, reportedFp: base.probedFp })).toBe("fingerprint");
  });
  it("calls a different fingerprint a mismatch, even when the address agrees", () => {
    expect(checkEnrolled({ ...base, reportedFp: "SHA256:" + "B".repeat(43), reportedAddresses: ["203.0.113.7"] })).toBe("mismatch");
  });
  it("falls back to a public address, and never to a private or Tailscale one", () => {
    expect(checkEnrolled({ ...base, reportedAddresses: ["198.51.100.1", "203.0.113.7"] })).toBe("address");
    expect(checkEnrolled({ ...base, coolifyAddress: "10.0.0.5", reportedAddresses: ["10.0.0.5"] })).toBe("unverified");
    expect(checkEnrolled({ ...base, coolifyAddress: "100.64.1.2", reportedAddresses: ["100.64.1.2"] })).toBe("unverified");
  });
  it("is unverified when nothing can be compared", () => {
    expect(checkEnrolled({ ...base, probedFp: null })).toBe("unverified");
  });
});

describe("codeOfError / helpers", () => {
  it("maps the hop failures to fixed codes", () => {
    expect(codeOfError(new AgentCommandTimeoutException("x"))).toBe("timeout");
    expect(codeOfError(new AgentOfflineException())).toBe("unreachable");
    expect(codeOfError(new AgentDisconnectedException("x"))).toBe("unreachable");
    expect(codeOfError(new ForbiddenException("x"))).toBe("cancelled");
    expect(codeOfError(new Error("boom with details"))).toBe("installer_failed");
  });
  it("keeps the per-host cap inside 1..8", () => {
    expect(clampPerHost(undefined)).toBe(4);
    expect(clampPerHost(0)).toBe(1);
    expect(clampPerHost(99)).toBe(8);
    expect(clampPerHost(3)).toBe(3);
    expect(clampPerHost(2.5)).toBe(4);
  });
  it("knows which states still have work in them", () => {
    for (const s of ["PLANNED", "PROBING", "TOKEN_MINTED", "INSTALLING", "WAIT_ENROLL", "UNINSTALLING"]) expect(isActiveState(s)).toBe(true);
    for (const s of ["READY", "ONLINE", "FAILED", "SKIPPED_PRESENT", "SKIPPED_FOREIGN", "REMOVED"]) expect(isActiveState(s)).toBe(false);
  });
});

describe("Semaphore", () => {
  it("never lets more than max run at once and frees waiters in order", async () => {
    const sem = new Semaphore(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const job = async (n: number) => {
      const release = await sem.acquire();
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      running--;
      release();
    };
    await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(job));
    expect(peak).toBe(2);
    expect(order.length).toBe(8);
    expect(sem.inFlight).toBe(0);
  });
  it("release is idempotent", async () => {
    const sem = new Semaphore(1);
    const r = await sem.acquire();
    r();
    r();
    const r2 = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    r2();
  });
});
