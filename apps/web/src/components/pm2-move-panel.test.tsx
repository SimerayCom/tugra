import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { api, ApiError } from "../lib/api";
import type { Pm2MoveJob, Pm2MovePlan, PublicUser } from "../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: true } as Partial<PublicUser> }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { Pm2MovePanel, pm2MoveErrorKey } from "./pm2-move-panel";

afterEach(cleanup);

function plan(over: Partial<Pm2MovePlan> = {}): Pm2MovePlan {
  return {
    key: "acme/api",
    user: "acme",
    name: "api",
    status: "ready",
    reasons: [],
    warnings: [],
    interpreter: null,
    nodeMajor: 20,
    nodeSource: "interpreter",
    image: "node:20",
    command: ["node", "/home/acme/htdocs/a/server.js"],
    workDir: "/home/acme/htdocs/a",
    mountDir: "/home/acme/htdocs/a",
    uid: 1001,
    gid: 1001,
    groups: [],
    port: 3000,
    portSource: "env",
    probePath: null,
    domains: ["a.example.com"],
    envCount: 6,
    sharedEnvCount: 0,
    planHash: "a".repeat(64),
    ...over,
  };
}
const PLANS: Pm2MovePlan[] = [
  plan(),
  plan({ key: "acme/py", name: "py", status: "unsupported", reasons: ["interpreter"], interpreter: "python3", nodeMajor: null, nodeSource: "none", image: null, command: [], port: null, planHash: "b".repeat(64) }),
  plan({ key: "acme/web", name: "web", status: "needs-node", nodeMajor: null, nodeSource: "none", image: null, planHash: "c".repeat(64) }),
  plan({ key: "acme/old", name: "old", warnings: ["node-eol", "root"], nodeMajor: 16, planHash: "d".repeat(64) }),
];

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.restoreAllMocks();
  h.user = { isInstanceOwner: true };
});
const show = (props: Partial<React.ComponentProps<typeof Pm2MovePanel>> = {}) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <Pm2MovePanel serverId="s1" online canOps {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
const openIt = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Move to Tugra" }));
  await screen.findByText("api");
};

describe("Pm2MovePanel", () => {
  it("is invisible to anyone but the instance owner", () => {
    h.user = { isInstanceOwner: false };
    const { container } = show();
    expect(container.textContent).toBe("");
  });

  it("is disabled with a reason when the server is offline or the member lacks server-ops", () => {
    show({ online: false });
    const b = screen.getByRole("button", { name: "Move to Tugra" });
    expect(b).toHaveProperty("disabled", true);
    expect(b.getAttribute("title")).toBe("The server is offline");
    cleanup();
    show({ canOps: false });
    expect(screen.getByRole("button", { name: "Move to Tugra" }).getAttribute("title")).toBe("You need server-ops permission to scan");
  });

  it("says which capabilities are missing, with the switch one click away, before the click", () => {
    show({ capabilities: ["deploy"] });
    expect(screen.getByRole("button", { name: "Move to Tugra" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/Needs the OS patching capability on this server\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Turn it on" }).getAttribute("href")).toBe("/servers/s1?tab=maintenance");
    cleanup();
    show({ capabilities: ["patch", "deploy"] });
    expect(screen.getByRole("button", { name: "Move to Tugra" })).toHaveProperty("disabled", false);
  });

  it("previews every process: ready, needs a Node version, and why one cannot move (never a fake action)", async () => {
    const spy = vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: PLANS, truncated: false });
    show();
    await openIt();
    expect(spy).toHaveBeenCalledWith("s1", []);
    expect(screen.getByText("It runs with python3, which isn't Node.")).toBeTruthy();
    expect(screen.getByText("Needs a Node version")).toBeTruthy();
    expect(screen.getByText("This Node version is past end of life. It keeps working, but plan an upgrade.")).toBeTruthy();
    expect(screen.getByText("Runs as root, same as in PM2 today.")).toBeTruthy();
    // Only ready processes can be picked or moved.
    expect((screen.getByRole("checkbox", { name: "py" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "web" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "api" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getAllByRole("button", { name: "Move to Tugra" })).toHaveLength(2); // api + old; none for py / web
    // The plan details are visible before anything happens.
    expect(screen.getAllByText("/home/acme/htdocs/a/server.js", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("a.example.com", { exact: false }).length).toBeGreaterThan(0);
  });

  it("choosing a Node version for a process re-plans with that choice", async () => {
    const spy = vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: PLANS, truncated: false });
    show();
    await openIt();
    fireEvent.change(screen.getByRole("combobox", { name: "Node version web" }), { target: { value: "22" } });
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("s1", [{ user: "acme", name: "web", nodeMajor: 22, probePath: null }]));
  });

  it("select-all picks only what can move, and the confirmation spells out downtime and rollback", async () => {
    vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: PLANS, truncated: false });
    show();
    await openIt();
    fireEvent.click(screen.getByRole("button", { name: "Select all that can move" }));
    expect(screen.getByRole("button", { name: "Move 2 selected" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move 2 selected" }));
    const dlg = screen.getByRole("group", { name: "Review before moving" });
    expect(within(dlg).getByText(/Downtime is a few seconds/)).toBeTruthy();
    expect(within(dlg).getByText(/the container is removed and the process is restarted in PM2 exactly as it was/)).toBeTruthy();
    expect(within(dlg).getByText(/Websites and DNS stay as they are/)).toBeTruthy();
    expect(within(dlg).getByText(/host networking and read-write access/)).toBeTruthy();
    expect(within(dlg).getByText("api")).toBeTruthy();
    expect(within(dlg).queryByText("py")).toBeNull();
    // Back leaves nothing started.
    const start = vi.spyOn(api, "startPm2Move");
    fireEvent.click(within(dlg).getByRole("button", { name: "Back" }));
    expect(start).not.toHaveBeenCalled();
  });

  it("confirm starts the job with the plan hashes of the preview, then shows progress and the result", async () => {
    vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: PLANS, truncated: false });
    const running: Pm2MoveJob = { id: "j1", serverId: "s1", state: "running", startedAt: "x", finishedAt: null, items: [{ key: "acme/api", user: "acme", name: "api", status: "running", step: "health", reason: null, appId: null, pm2Left: false, logTail: [], errTail: [] }] };
    const finished: Pm2MoveJob = {
      ...running,
      state: "done",
      finishedAt: "y",
      items: [
        { ...running.items[0], status: "moved", step: "delete", reason: "ok", appId: "app9", pm2Left: true },
        { key: "acme/old", user: "acme", name: "old", status: "rolled_back", step: "health", reason: "not_listening", appId: null, pm2Left: false, logTail: ["Error: EADDRINUSE"], errTail: [] },
      ],
    };
    const start = vi.spyOn(api, "startPm2Move").mockResolvedValue(running);
    const getJob = vi.spyOn(api, "getPm2MoveJob").mockResolvedValue(finished);
    show();
    await openIt();
    fireEvent.click(screen.getByRole("checkbox", { name: "api" }));
    fireEvent.click(screen.getByRole("button", { name: "Move 1 selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and move" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith("s1", { items: [{ user: "acme", name: "api", planHash: "a".repeat(64), nodeMajor: undefined, probePath: null }] }));
    expect(await screen.findByText("Move finished")).toBeTruthy();
    expect(getJob).toHaveBeenCalledWith("s1", "j1");
    expect(screen.getByText("Moved")).toBeTruthy();
    expect(screen.getByText("Rolled back, PM2 is running it again")).toBeTruthy();
    expect(screen.getByText("The port never opened.")).toBeTruthy();
    expect(screen.getByText(/couldn't be removed from PM2/)).toBeTruthy(); // the leftover-entry warning
    expect((screen.getByRole("link", { name: "Open app" }) as HTMLAnchorElement).getAttribute("href")).toBe("/apps/app9");
    expect(screen.getByText("Error: EADDRINUSE")).toBeTruthy(); // the app's last output, as text
    expect(screen.getByText("Scan the server again to refresh this list.")).toBeTruthy();
  });

  it("an in-flight job shows the step it is on", async () => {
    vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: [PLANS[0]], truncated: false });
    vi.spyOn(api, "startPm2Move").mockResolvedValue({ id: "j1", serverId: "s1", state: "running", startedAt: "x", finishedAt: null, items: [{ key: "acme/api", user: "acme", name: "api", status: "running", step: "stop", reason: null, appId: null, pm2Left: false, logTail: [], errTail: [] }] });
    vi.spyOn(api, "getPm2MoveJob").mockResolvedValue({ id: "j1", serverId: "s1", state: "running", startedAt: "x", finishedAt: null, items: [{ key: "acme/api", user: "acme", name: "api", status: "running", step: "stop", reason: null, appId: null, pm2Left: false, logTail: [], errTail: [] }] });
    show();
    await openIt();
    fireEvent.click(screen.getByRole("button", { name: "Move to Tugra" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm and move" }));
    expect(await screen.findByText("Stopping in PM2")).toBeTruthy();
    expect(screen.getByText("Moving")).toBeTruthy();
  });

  it("a hostile process name renders as text, never markup", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: [plan({ name: evil, key: `acme/${evil}` })], truncated: false });
    const { container } = show();
    fireEvent.click(screen.getByRole("button", { name: "Move to Tugra" }));
    expect(await screen.findByText(evil)).toBeTruthy();
    expect(container.querySelector("img[onerror]")).toBeNull();
  });

  it("maps failures to honest messages", async () => {
    expect(pm2MoveErrorKey(new ApiError(403, "owner only"))).toBe("errOwner");
    expect(pm2MoveErrorKey(new ApiError(403, "capability \"patch\" is not granted"))).toBe("errForbidden");
    expect(pm2MoveErrorKey(new ApiError(409, "a PM2 move is already running on this server"))).toBe("errBusy");
    expect(pm2MoveErrorKey(new ApiError(503, "update this server's agent to read its PM2 processes"))).toBe("errOutdated");
    expect(pm2MoveErrorKey(new ApiError(503, "the saved environment of this PM2 process is too large to move"))).toBe("errTooLarge");
    expect(pm2MoveErrorKey(new ApiError(503, "x"))).toBe("errUnavailable");
    expect(pm2MoveErrorKey(new Error("x"))).toBe("errGeneric");
    vi.spyOn(api, "planPm2Move").mockRejectedValue(new ApiError(503, "update this server's agent to read its PM2 processes"));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Move to Tugra" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Update this server's agent to read its PM2 processes.");
  });

  it("an invalid health-check path is flagged in the field and never sent, so the preview keeps working", async () => {
    const spy = vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: PLANS, truncated: false });
    show();
    await openIt();
    const calls = spy.mock.calls.length;
    const box = screen.getByRole("textbox", { name: "Health check path (optional) api" });
    for (const bad of ["health", "/a?x=1", "/a b".replace(" ", "%")]) {
      fireEvent.change(box, { target: { value: bad } });
      fireEvent.blur(box);
      expect((await screen.findByText(/Start with \//)).textContent).toContain("no spaces");
      expect(box.getAttribute("aria-invalid")).toBe("true");
    }
    expect(spy.mock.calls.length).toBe(calls); // nothing was sent for any of them
    // The row cannot be moved with a path that was not applied.
    const enabled = screen.getAllByRole("button", { name: "Move to Tugra" }).filter((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(1); // only "old"
    fireEvent.change(box, { target: { value: "/health" } });
    expect(screen.queryByText(/Start with \//)).toBeNull();
    fireEvent.blur(box);
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("s1", [{ user: "acme", name: "api", nodeMajor: undefined, probePath: "/health" }]));
  });

  it("a Node version guessed from the project files has to be confirmed; the choice re-plans as an override", async () => {
    const guessed = plan({ key: "acme/g", name: "g", status: "needs-node", nodeMajor: 18, nodeSource: "engines", warnings: ["node-guessed"], planHash: "e".repeat(64) });
    const spy = vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: [guessed], truncated: false });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Move to Tugra" }));
    await screen.findByText("g");
    expect(screen.getByText(/from the project files/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "g" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Use Node 18" }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith("s1", [{ user: "acme", name: "g", nodeMajor: 18, probePath: null }]));
  });

  it("names the supplementary groups, the team shared variables, and where the environment comes from", async () => {
    vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: [plan({ groups: [33, 50], sharedEnvCount: 4, warnings: ["shared-env"] })], truncated: false });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Move to Tugra" }));
    await screen.findByText("api");
    expect(screen.getByText("33, 50")).toBeTruthy();
    expect(screen.getByText(/Your team has 4 shared variables/)).toBeTruthy();
    expect(screen.getByText(/never saved isn't included/)).toBeTruthy();
  });

  it("an empty server says so", async () => {
    vi.spyOn(api, "planPm2Move").mockResolvedValue({ plans: [], truncated: false });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Move to Tugra" }));
    expect(await screen.findByText("No PM2 processes found.")).toBeTruthy();
  });
});
