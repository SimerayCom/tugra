import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "../components/confirm";
import { ToastProvider } from "../components/toast";
import { api } from "../lib/api";
import { useUiModeSwitch } from "./useUiModeSwitch";

const auth = vi.hoisted(() => ({ mode: "fleet" as "fleet" | "home", reload: vi.fn(async () => {}) }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { uiMode: auth.mode }, reload: auth.reload }) }));

const srv = (i: number, teamId = "t0") => ({ id: `s${i}`, name: `app-${i}`, teamId, status: "ONLINE" });

function Harness({ to }: { to: "fleet" | "home" }) {
  const { switchTo } = useUiModeSwitch();
  return <button onClick={() => void switchTo(to)}>switch</button>;
}
function mount(to: "fleet" | "home", servers: unknown[], teams: unknown[]) {
  vi.spyOn(api, "listServers").mockResolvedValue(servers as never);
  vi.spyOn(api, "listTeams").mockResolvedValue(teams as never);
  vi.spyOn(api, "listApps").mockResolvedValue([]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>
          <ToastProvider>
            <Harness to={to} />
          </ToastProvider>
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
// The hook reads server/team counts from the query cache — wait until it has them.
const loaded = () => waitFor(() => expect(api.listTeams).toHaveBeenCalled()).then(() => new Promise((r) => setTimeout(r, 20)));

describe("useUiModeSwitch", () => {
  let update: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auth.mode = "fleet";
    auth.reload.mockClear();
    update = vi.spyOn(api, "updateProfile").mockResolvedValue({} as never);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("Fleet -> Home with 27 servers and 8 teams asks first, with the counts", async () => {
    mount("home", Array.from({ length: 27 }, (_, i) => srv(i, `t${i % 8}`)), Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, name: `Team ${i}` })));
    await loaded();
    fireEvent.click(screen.getByText("switch"));
    expect(await screen.findByText(/27 servers and 8 teams/)).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Switch to Home"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ uiMode: "home" }));
    // one-click undo restores the previous mode
    fireEvent.click(await screen.findByText("Undo"));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ uiMode: "fleet" }));
  });

  it("asks with a generic explanation while the counts cannot be read", async () => {
    vi.spyOn(api, "listServers").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "listTeams").mockResolvedValue([] as never);
    vi.spyOn(api, "listApps").mockResolvedValue([]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider><ConfirmProvider><ToastProvider><Harness to="home" /></ToastProvider></ConfirmProvider></I18nProvider>
      </QueryClientProvider>,
    );
    await loaded();
    fireEvent.click(screen.getByText("switch"));
    expect(await screen.findByText("Switch to Home mode?")).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
  });

  it("cancelling the confirmation leaves the mode untouched", async () => {
    mount("home", [srv(1), srv(2)], [{ id: "t0", name: "Acme" }]);
    await loaded();
    fireEvent.click(screen.getByText("switch"));
    fireEvent.click(await screen.findByText("Cancel"));
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();
  });

  it("Fleet -> Home on a single box switches straight away (undo still offered)", async () => {
    mount("home", [srv(1)], [{ id: "t0", name: "Acme" }]);
    await loaded();
    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ uiMode: "home" }));
    expect(screen.queryByText("Switch to Home mode?")).toBeNull();
    expect(await screen.findByText("Undo")).toBeTruthy();
  });

  it("Home -> Fleet never asks, whatever the size", async () => {
    auth.mode = "home";
    mount("fleet", Array.from({ length: 30 }, (_, i) => srv(i)), [{ id: "t0", name: "Acme" }]);
    await loaded();
    fireEvent.click(screen.getByText("switch"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ uiMode: "fleet" }));
    expect(screen.queryByText("Switch to Home mode?")).toBeNull();
  });
});
