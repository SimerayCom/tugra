import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { ToastProvider } from "../toast";
import { GuidedStartAction, GuidedStartBar, type GuidedStartProps } from "./guided-run-launcher";
import { LAUNCH_HANDOFF_KEY, loadLaunchHandoff } from "../../lib/launch-handoff";
import type { ImportPlan } from "../../lib/types";
import type { ImportScope } from "../../lib/import-scope";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const plan = { sourceKind: "coolify", mode: "copy", planHash: "a".repeat(32), warnings: [], totals: { apps: 1, databases: 0, volumes: 0, blockers: 0 }, items: [] } as ImportPlan;
const scope: ImportScope = {
  selection: { mode: "everything", hosts: new Set(), projects: new Set(), extra: new Set(), placement: {} },
  inScope: new Set(["app:s1:web"]),
  narrowed: false,
  defaultServerId: "srv1",
  serverMap: undefined,
  placed: { s1: "srv1", s2: "srv2" },
  placementKind: { s1: "in-place", s2: "in-place" },
};
const base: GuidedStartProps = { plan, kind: "coolify", sessionId: "session-abc12345", extras: { acks: [{ code: "app.env.unresolved", itemRef: "app:s1:web" }] }, scope, replanning: false, consentMissing: false, runnable: 1, unackedCount: 0, missingTargets: 0 };
const mount = (over: Partial<GuidedStartProps> = {}, bar = false) =>
  render(
    <I18nProvider>
      <ToastProvider>
        {bar ? <GuidedStartBar props={{ ...base, ...over }} /> : <GuidedStartAction props={{ ...base, ...over }} testId="start" />}
      </ToastProvider>
    </I18nProvider>,
  );

beforeEach(() => {
  push.mockReset();
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("the preview's start action", () => {
  it("is a primary button that says what it moves, and opens the launch page (no dialog) with the choices", () => {
    mount();
    const btn = screen.getByRole("button", { name: "Move 2 servers in place" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(push).toHaveBeenCalledWith("/import/guided/new?s=session-abc12345");
    const h = loadLaunchHandoff();
    expect(h?.planHash).toBe("a".repeat(32));
    expect(h?.extras.acks).toEqual(base.extras.acks);
    expect(h?.scope?.placed).toEqual({ s1: "srv1", s2: "srv2" });
  });

  it("says in one line why it is off, with a link to the answer", () => {
    mount({ unackedCount: 2 });
    expect((screen.getByRole("button", { name: "Move 2 servers in place" }) as HTMLButtonElement).disabled).toBe(true);
    const why = screen.getByTestId("start-why");
    expect(why.textContent).toContain("2 warnings need your answer.");
    expect(within(why).getByRole("link", { name: "Show me" }).getAttribute("href")).toBe("#import-env-blockers");
    fireEvent.click(screen.getByRole("button", { name: "Move 2 servers in place" }));
    expect(push).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(LAUNCH_HANDOFF_KEY)).toBeNull();
  });

  it("names the target server of a copy", () => {
    mount({ scope: { ...scope, placed: { s1: "srv1" }, placementKind: { s1: "other-server" } }, serverNames: { srv1: "Server A" } });
    expect(screen.getByRole("button", { name: "Move to Server A" })).toBeTruthy();
  });

  it("is repeated in a sticky bar at the end of the page, with the same action", () => {
    mount({}, true);
    const bar = screen.getByTestId("guided-start-bar");
    expect(bar.style.position).toBe("sticky");
    expect(bar.style.bottom).toBe("0px");
    fireEvent.click(screen.getByRole("button", { name: "Move 2 servers in place" }));
    expect(push).toHaveBeenCalledWith("/import/guided/new?s=session-abc12345");
  });
});
