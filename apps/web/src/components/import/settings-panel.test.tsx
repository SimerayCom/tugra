import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { I18nProvider } from "../../i18n/provider";
import { ToastProvider } from "../toast";
import { ImportSettingsPanel } from "./settings-panel";
import { api } from "../../lib/api";
import type { SettingsPreview } from "../../lib/import-settings";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><ToastProvider>{ui}</ToastProvider></I18nProvider></QueryClientProvider>);

const unavailable = (section: SettingsPreview["sections"][number]["section"]) => ({ section, available: false, reason: "not_exposed" as const, entries: [] });
const base: SettingsPreview = {
  supported: true,
  sections: [
    {
      section: "notifications",
      available: true,
      entries: [
        { id: "notification:telegram", section: "notifications", name: "telegram", selectable: true, defaultSelected: true, notes: [{ level: "warn", code: "events_not_carried", params: { events: "server_patch" } }, { level: "info", code: "double_send" }], detail: { kind: "telegram", enabled: true, groups: [{ threadId: "5", coolifyEvents: ["deployment_success"], tugraEvents: ["deploy_success"], events: [{ from: "deployment_success", to: ["deploy_success"] }] }], targetNames: [] } },
        { id: "notification:discord", section: "notifications", name: "discord", selectable: false, defaultSelected: false, blocked: "needs_sensitive", notes: [], detail: { kind: "discord", enabled: true, groups: [] } },
      ],
    },
    unavailable("sharedVariables"),
    {
      section: "storages",
      available: true,
      entries: [{ id: "storage:s1", section: "storages", name: "Acme backups", selectable: true, defaultSelected: false, needs: ["s3Credentials"], notes: [{ level: "info", code: "credentials_not_exposed" }], detail: { type: "s3", endpoint: "https://s3.example.com", bucket: "acme", region: "eu-1" } }],
    },
    unavailable("scheduledTasks"),
    unavailable("serverSettings"),
    unavailable("tags"),
    {
      section: "members",
      available: true,
      entries: [{ id: "member:ann@example.com", section: "members", name: "ann@example.com", selectable: true, defaultSelected: false, needs: ["role"], notes: [], detail: { email: "ann@example.com", displayName: "Ann", suggestedRole: "VIEWER" } }],
    },
  ],
};

describe("ImportSettingsPanel", () => {
  beforeEach(() => {
    vi.spyOn(api, "importSettingsPreview").mockResolvedValue(base);
  });

  it("lists each section, says plainly when the API does not offer one, and explains a blocked entry", async () => {
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" servers={[]} />);
    await screen.findByText("Notification channels");
    expect(api.importSettingsPreview).toHaveBeenCalledWith({ sessionId: "s1", sourceKind: "coolify" });
    expect(screen.getAllByText("Not available via the Coolify API.").length).toBe(4);
    expect(screen.getByText("Needs a Coolify token with read:sensitive.")).toBeTruthy();
    const discord = screen.getAllByRole("checkbox")[1] as HTMLInputElement;
    expect(discord.disabled).toBe(true);
    // the hub's default is ticked, the rest is not
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
  });

  it("passes the operation id so tasks and tags can find the imported apps", async () => {
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" opId="op-9" servers={[]} />);
    await screen.findByText("Notification channels");
    expect(api.importSettingsPreview).toHaveBeenCalledWith({ sessionId: "s1", sourceKind: "coolify", opId: "op-9" });
  });

  it("shows the other notes behind More", async () => {
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" servers={[]} />);
    await screen.findByText("Notification channels");
    expect(screen.getAllByText("More").length).toBeGreaterThan(0);
    expect(screen.getByText("Not carried, Tugra has no event for: server_patch.")).toBeTruthy();
  });

  it("shows each Coolify event with the Tugra event it becomes, and the double-send reminder next to the channel", async () => {
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" servers={[]} />);
    await screen.findByText("Notification channels");
    expect(screen.getByText("deployment_success becomes deploy_success")).toBeTruthy();
    // inline (not only behind More): the reminder is a sibling of the row, outside the <details>
    const reminder = screen.getByText("Turn it off in Coolify after the test, or messages arrive twice.");
    expect(reminder.closest("details")).toBeNull();
  });

  it("sends the team the import lands in", async () => {
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" teamId="team-2" servers={[]} />);
    await screen.findByText("Notification channels");
    expect(api.importSettingsPreview).toHaveBeenCalledWith({ sessionId: "s1", sourceKind: "coolify", teamId: "team-2" });
  });

  it("server cleanup is never pre-selected nor pre-mapped; the volume warning is inline; one Tugra server cannot take two cleanups", async () => {
    const srv = (ref: string) => ({ id: `server:${ref}`, section: "serverSettings" as const, name: ref, selectable: true, defaultSelected: false, needs: ["server" as const], notes: [{ level: "warn" as const, code: "volumes_pruned" }], detail: { server: ref, schedule: "0 4 * * *", volumes: true } });
    vi.spyOn(api, "importSettingsPreview").mockResolvedValue({ supported: true, sections: [{ section: "serverSettings", available: true, entries: [srv("a"), srv("b")] }] });
    const apply = vi.spyOn(api, "importSettingsApply").mockResolvedValue({ counts: { created: 1, skipped: 0, failed: 0 }, results: [] });
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" servers={[{ id: "t1", name: "Server one" }, { id: "t2", name: "Server two" }]} />);
    await screen.findByText("Server cleanup");
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.every((b) => !b.checked)).toBe(true);
    expect(screen.getAllByText("This also removes unused volumes.").every((n) => n.closest("details") === null)).toBe(true);
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    const selects = screen.getAllByLabelText("Target server") as HTMLSelectElement[];
    expect(selects.every((x) => x.value === "")).toBe(true); // no default target
    fireEvent.change(selects[0], { target: { value: "t1" } });
    fireEvent.change(selects[1], { target: { value: "t1" } });
    expect(screen.getByText("Choose a different server for each one.")).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.change(selects[1], { target: { value: "t2" } });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0][0]).toMatchObject({ serverMap: { a: "t1", b: "t2" } });
  });

  it("a storage needs the keys (Coolify never gives them); they are sent once and cleared, and the recovery key is shown once", async () => {
    const apply = vi.spyOn(api, "importSettingsApply").mockResolvedValue({ counts: { created: 2, skipped: 0, failed: 0 }, results: [{ id: "notification:telegram", section: "notifications", status: "created", channels: [{ id: "ch-1", name: "Telegram (Coolify) - topic 5" }] }, { id: "storage:s1", section: "storages", status: "created", recoveryKey: "recovery-key-once" }] });
    const test = vi.spyOn(api, "testChannel").mockResolvedValue({ ok: true });
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" servers={[]} />);
    await screen.findByText("Notification channels");
    fireEvent.click(screen.getByLabelText(/^Acme backups/));
    const importBtn = screen.getByRole("button", { name: "Import selected" }) as HTMLButtonElement;
    expect(screen.getByText("Fill in the missing fields to include it.")).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy(); // only the telegram default is ready
    fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "AK1" } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "SK1" } });
    expect((screen.getByLabelText("Secret key") as HTMLInputElement).type).toBe("password");
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(importBtn);
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0][0]).toEqual({ sessionId: "s1", sourceKind: "coolify", select: ["notification:telegram", "storage:s1"], s3Credentials: { "storage:s1": { accessKey: "AK1", secretKey: "SK1" } } });
    await screen.findByText("recovery-key-once");
    expect(screen.getByText(/shown only once/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(test).toHaveBeenCalledWith("ch-1"));
  });

  it("invitations are never sent without the confirmation checkbox", async () => {
    const apply = vi.spyOn(api, "importSettingsApply").mockResolvedValue({ counts: { created: 1, skipped: 0, failed: 0 }, results: [{ id: "member:ann@example.com", section: "members", status: "created" }] });
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" servers={[]} />);
    await screen.findByText("Team members");
    fireEvent.click(screen.getByLabelText(/^ann@example.com/));
    // untick the telegram default so only the member is selected
    fireEvent.click(screen.getByLabelText(/^Telegram/));
    const importBtn = screen.getByRole("button", { name: "Import selected" }) as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Send invitation emails to the people selected."));
    expect(importBtn.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "ADMIN" } });
    fireEvent.click(importBtn);
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0][0]).toMatchObject({ select: ["member:ann@example.com"], memberRoles: { "member:ann@example.com": "ADMIN" }, confirmInvites: true });
  });

  it("renders nothing for a source without settings and for Dokploy", async () => {
    vi.spyOn(api, "importSettingsPreview").mockResolvedValue({ supported: false, sections: [] });
    const { container } = wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" servers={[]} />);
    await waitFor(() => expect(api.importSettingsPreview).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
    cleanup();
    const spy = vi.spyOn(api, "importSettingsPreview");
    spy.mockClear();
    const d = wrap(<ImportSettingsPanel sessionId="s1" kind="dokploy" servers={[]} />);
    expect(d.container.textContent).toBe("");
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unreadable preview is a short message with a retry, not a crash", async () => {
    vi.spyOn(api, "importSettingsPreview").mockRejectedValue(new Error("boom"));
    wrap(<ImportSettingsPanel sessionId="s1" kind="coolify" servers={[]} />);
    expect(await screen.findByText("Settings could not be read.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("settings panel source", () => {
  it("has no hardcoded English sentence (strings go through t())", () => {
    const src = readFileSync(path.resolve(__dirname, "settings-panel.tsx"), "utf8");
    const jsxText = [...src.matchAll(/>([^<>{}\n]*[A-Za-z]{3,}\s+[A-Za-z]{3,}\s+[A-Za-z]{3,}[^<>{}\n]*)</g)].map((m) => m[1].trim());
    expect(jsxText).toEqual([]);
  });
});
