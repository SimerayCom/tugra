import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { EnvCard } from "./env-card";
import { api } from "../lib/api";

vi.mock("../lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(true) }));
import { copyText } from "../lib/clipboard";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
  vi.mocked(copyText).mockResolvedValue(true);
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{ui}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

const vals = (label: string) => screen.getAllByLabelText(label).map((e) => (e as HTMLInputElement).type);

describe("EnvCard", () => {
  it("masks values by default and reveals a single row via its per-row toggle (aria-pressed)", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ TOKEN: "s3cr3t", URL: "http://x" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("s3cr3t");
    expect(vals("Value")).toEqual(["password", "password"]); // both masked up front
    const reveals = screen.getAllByRole("button", { name: "Reveal value" });
    expect(reveals[0].getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(reveals[0]);
    expect(vals("Value")).toEqual(["text", "password"]); // only the first row revealed
    expect(screen.getByRole("button", { name: "Hide value" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("reveal-all toggles every row and masks again when pressed off", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1", B: "2" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    const toggle = screen.getByRole("button", { name: "Show values" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(vals("Value")).toEqual(["text", "text"]);
    fireEvent.click(screen.getByRole("button", { name: "Hide values" })); // same toggle, now "on"
    expect(vals("Value")).toEqual(["password", "password"]);
  });

  it("auto-re-masks a revealed value after 30s", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
      wrap(<EnvCard id="a1" canWrite />);
      await vi.waitFor(() => expect(screen.getByDisplayValue("1")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Reveal value" }));
      expect((screen.getByLabelText("Value") as HTMLInputElement).type).toBe("text");
      act(() => { vi.advanceTimersByTime(30_000); });
      expect((screen.getByLabelText("Value") as HTMLInputElement).type).toBe("password");
    } finally {
      vi.useRealTimers();
    }
  });

  it("copies a row value to the clipboard", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ TOKEN: "s3cr3t" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("s3cr3t");
    fireEvent.click(screen.getByRole("button", { name: "Copy value" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("s3cr3t"));
  });

  it("bulk edit shows a live parsed count, blocks Apply at zero (wipe-guard), and Cancel returns to rows", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Bulk edit" }));
    const ta = screen.getByLabelText("Bulk edit") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", true); // empty = would wipe
    fireEvent.change(ta, { target: { value: "X=1\nY=2" } });
    expect(screen.getByText("2 parsed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByDisplayValue("1")).toBeTruthy(); // back to row edit, unchanged
  });

  it("blocks Save on a duplicate key and surfaces an alert", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const keys = screen.getAllByLabelText("Key");
    fireEvent.change(keys[keys.length - 1], { target: { value: "A" } }); // duplicate of the existing A
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("enables Save only once the env has changed, then PUTs the map", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    const set = vi.spyOn(api, "setAppEnv").mockResolvedValue({ ok: true });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true); // pristine
    fireEvent.change(screen.getByDisplayValue("1"), { target: { value: "2" } });
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", false);
    fireEvent.click(save);
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { A: "2" }));
  });

  it("read-only viewers can reveal and copy but get no editing controls", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ TOKEN: "s3cr3t" });
    wrap(<EnvCard id="a1" canWrite={false} />);
    await screen.findByDisplayValue("s3cr3t");
    expect((screen.getByLabelText("Key") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText("Value") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add variable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bulk edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reveal value" })).toBeTruthy(); // reveal still allowed
    expect(screen.getByRole("button", { name: "Copy value" })).toBeTruthy();
  });

  it("shows a no-match line when a search filters everything out", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ ALPHA: "1", BETA: "2", GAMMA: "3", DELTA: "4" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    fireEvent.change(screen.getByLabelText("Search keys…"), { target: { value: "zzz" } });
    expect(screen.getByText(/no keys match/i)).toBeTruthy();
  });

  it("removing a row re-indexes reveals so another row's secret is not exposed", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1", B: "2", C: "3" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("2");
    fireEvent.click(screen.getAllByRole("button", { name: "Reveal value" })[1]); // reveal B (index 1)
    expect((screen.getByDisplayValue("2") as HTMLInputElement).type).toBe("text");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]); // remove A (index 0)
    expect((screen.getByDisplayValue("2") as HTMLInputElement).type).toBe("text"); // B stays revealed
    expect((screen.getByDisplayValue("3") as HTMLInputElement).type).toBe("password"); // C NOT leaked
  });

  it("re-masks revealed rows when a bulk edit replaces them", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Reveal value" }));
    expect((screen.getByDisplayValue("1") as HTMLInputElement).type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Bulk edit" }));
    fireEvent.change(screen.getByLabelText("Bulk edit"), { target: { value: "A=1\nB=2" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect((screen.getByDisplayValue("1") as HTMLInputElement).type).toBe("password"); // re-masked after bulk apply
    expect((screen.getByDisplayValue("2") as HTMLInputElement).type).toBe("password");
  });

  it("shows a newly added blank row even while a search filter is active", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ ALPHA: "1", BETA: "2", GAMMA: "3", DELTA: "4" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    fireEvent.change(screen.getByLabelText("Search keys…"), { target: { value: "zzz" } });
    expect(screen.getByText(/no keys match/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    // The blank row is now visible (not swallowed by the filter): a Key input with an empty value exists.
    const keys = screen.getAllByLabelText("Key") as HTMLInputElement[];
    expect(keys.some((k) => k.value === "")).toBe(true);
    expect(screen.queryByText(/no keys match/i)).toBeNull();
  });
});
