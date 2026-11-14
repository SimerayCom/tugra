import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ToastProvider } from "./toast";
import { EnvCard } from "./env-card";
import { api, ApiError } from "../lib/api";

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

  it("sort A-Z reorders the displayed rows by key (view only) and toggles back", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ ZEBRA: "1", alpha: "2", MIKE: "3" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    const keys = () => (screen.getAllByLabelText("Key") as HTMLInputElement[]).map((e) => e.value);
    expect(keys()).toEqual(["ZEBRA", "alpha", "MIKE"]); // insertion order
    fireEvent.click(screen.getByRole("button", { name: "Sort A-Z" }));
    expect(keys()).toEqual(["alpha", "MIKE", "ZEBRA"]); // case-insensitive alpha sort (view only)
    fireEvent.click(screen.getByRole("button", { name: "Clear sort" }));
    expect(keys()).toEqual(["ZEBRA", "alpha", "MIKE"]); // back to stored order
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
  it("surfaces a duplicate key inline on the row (icon + message, described-by) and keeps Save blocked", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const keys = screen.getAllByLabelText("Key") as HTMLInputElement[];
    fireEvent.change(keys[1], { target: { value: "A" } });
    const rowMsgs = screen.getAllByTestId("env-row-problem");
    expect(rowMsgs).toHaveLength(2); // both colliding rows are flagged
    expect(rowMsgs[0].textContent).toContain('Duplicate key');
    expect(rowMsgs[0].querySelector("svg")).toBeTruthy(); // inline icon
    expect(keys[1].getAttribute("aria-invalid")).toBe("true");
    expect(keys[1].getAttribute("aria-describedby")).toBe(rowMsgs[1].id);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces an invalid key name and a value-without-key inline, without blocking Save", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    const keys = screen.getAllByLabelText("Key") as HTMLInputElement[];
    const values = screen.getAllByLabelText("Value") as HTMLInputElement[];
    fireEvent.change(keys[1], { target: { value: "1BAD" } });
    fireEvent.change(values[2], { target: { value: "orphan" } });
    const rowMsgs = screen.getAllByTestId("env-row-problem");
    expect(rowMsgs[0].textContent).toContain("Not a valid variable name");
    expect(rowMsgs[1].textContent).toContain("Key required");
    expect(rowMsgs.every((m) => m.querySelector("svg"))).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows no inline problem for a clean env, and guards leaving only while dirty", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    expect(screen.queryAllByTestId("env-row-problem")).toHaveLength(0);
    const unload = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    expect(unload()).toBe(false);
    fireEvent.change(screen.getByDisplayValue("1"), { target: { value: "2" } });
    expect(unload()).toBe(true);
  });
});

describe("EnvCard — per-variable flags (flagsEnabled)", () => {
  const view = (o: Partial<{ buildTime: boolean; runtime: boolean; literal: boolean; multiline: boolean }> = {}) => ({ buildTime: false, runtime: true, literal: false, multiline: false, ...o });
  const flagsResp = (flags: Record<string, ReturnType<typeof view>> = {}, applicable = { buildTime: true, literal: false }) => ({
    flags,
    applicable,
    limits: { multilineValueBytes: 16384, multilineKeys: 32, multilineTotalBytes: 49152, buildTotalBytes: 49152 },
  });
  const setup = (env: Record<string, string>, flags = flagsResp(), canWrite = true) => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue(env);
    vi.spyOn(api, "getAppEnvFlags").mockResolvedValue(flags);
    const setAppEnv = vi.spyOn(api, "setAppEnv").mockResolvedValue({ ok: true });
    wrap(<EnvCard id="a1" canWrite={canWrite} flagsEnabled />);
    return { setAppEnv };
  };
  const saveBtn = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

  it("loads flags, shows chips for non-default flags, and the plain card (no flagsEnabled) never asks for them", async () => {
    setup({ A: "1", B: "2" }, flagsResp({ A: view({ buildTime: true, runtime: false }), B: view({ multiline: true }) }));
    await screen.findByDisplayValue("1");
    expect(screen.getByText("Build only")).toBeTruthy();
    expect(screen.getByText("Multiline")).toBeTruthy();
    expect(api.getAppEnvFlags).toHaveBeenCalledWith("a1");
    cleanup();
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    const spy = vi.spyOn(api, "getAppEnvFlags");
    spy.mockClear();
    wrap(<EnvCard id="a1" canWrite />);
    await screen.findByDisplayValue("1");
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Variable options" })).toBeNull();
  });

  it("Save stays disabled until BOTH queries loaded (never a PUT with partial state)", async () => {
    vi.spyOn(api, "getAppEnv").mockResolvedValue({ A: "1" });
    let release!: (v: ReturnType<typeof flagsResp>) => void;
    vi.spyOn(api, "getAppEnvFlags").mockReturnValue(new Promise((r) => (release = r)));
    wrap(<EnvCard id="a1" canWrite flagsEnabled />);
    await waitFor(() => expect(api.getAppEnv).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull(); // spinner, no editor yet
    await act(async () => release(flagsResp()));
    await screen.findByDisplayValue("1");
    expect(saveBtn().disabled).toBe(true);
  });

  it("the options panel toggles each flag; a flag-only edit enables Save and the PUT carries flags", async () => {
    const { setAppEnv } = setup({ A: "1" });
    await screen.findByDisplayValue("1");
    const optsBtn = screen.getByRole("button", { name: "Variable options" });
    expect(optsBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(optsBtn);
    expect(optsBtn.getAttribute("aria-expanded")).toBe("true");
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Multiline value"));
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Available at build time"));
    expect(screen.getByLabelText("Available at runtime")).toBeTruthy(); // only shown once build time is on
    fireEvent.click(screen.getByLabelText("Available at runtime"));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(setAppEnv).toHaveBeenCalled());
    expect(setAppEnv).toHaveBeenCalledWith("a1", { A: "1" }, { A: { buildTime: true, runtime: false, literal: false, multiline: true } });
  });

  it("applicable flags hide Build/Literal: Literal shows the inert note, Build is absent", async () => {
    setup({ A: "1" }, flagsResp({}, { buildTime: false, literal: false }));
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Variable options" }));
    expect(screen.queryByLabelText("Available at build time")).toBeNull();
    expect(screen.queryByLabelText("Literal value")).toBeNull();
    expect(screen.getByText("This app type already passes every value literally.")).toBeTruthy();
    expect(screen.getByLabelText("Multiline value")).toBeTruthy();
  });

  it("a Compose app shows the Literal checkbox", async () => {
    setup({ A: "1" }, flagsResp({}, { buildTime: false, literal: true }));
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Variable options" }));
    expect(screen.getByLabelText("Literal value")).toBeTruthy();
  });

  it("a multiline row is a textarea named Value when revealed, and a masked 'N lines' block otherwise", async () => {
    setup({ PEM: "l1\nl2\nl3" }, flagsResp({ PEM: view({ multiline: true }) }));
    await screen.findByTestId("env-ml-masked");
    expect(screen.getByTestId("env-ml-masked").textContent).toContain("3 lines");
    expect(screen.queryByLabelText("Value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal value" }));
    const ta = screen.getByLabelText("Value") as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.value).toBe("l1\nl2\nl3");
  });

  it("pasting text with line breaks into a single-line value turns Multiline on and keeps the full text", async () => {
    const { setAppEnv } = setup({ K: "" });
    await screen.findByLabelText("Value");
    const input = screen.getByLabelText("Value") as HTMLInputElement;
    fireEvent.paste(input, { clipboardData: { getData: () => "-----BEGIN-----\nabc\n-----END-----" } });
    const ta = (await screen.findByRole("button", { name: "Reveal value" })) && screen.getByTestId("env-ml-masked");
    expect(ta.textContent).toContain("3 lines");
    expect(screen.getByText("Multiline")).toBeTruthy(); // chip
    fireEvent.click(saveBtn());
    await waitFor(() => expect(setAppEnv).toHaveBeenCalled());
    expect(setAppEnv.mock.calls[0][1]).toEqual({ K: "-----BEGIN-----\nabc\n-----END-----" });
    expect(setAppEnv.mock.calls[0][2]).toMatchObject({ K: { multiline: true } });
  });

  it("bulk edit: a quoted multiline value gets the flag, existing flags survive a bulk apply", async () => {
    setup({ A: "1" }, flagsResp({ A: view({ literal: true }) }, { buildTime: true, literal: true }));
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getByRole("button", { name: "Bulk edit" }));
    const ta = screen.getByLabelText("Bulk edit") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'A=1\nPEM="l1\nl2"' } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("Literal")).toBeTruthy(); // A kept its flag
    expect(screen.getByTestId("env-ml-masked").textContent).toContain("2 lines"); // PEM auto-multiline
  });

  it("a line break without the flag (legacy data) shows an inline error, blocks Save, and one click turns Multiline on", async () => {
    // jsdom strips line breaks typed into an <input>, so seed the state from stored data instead.
    setup({ A: "a\nb", B: "x" });
    await screen.findByDisplayValue("x");
    expect(screen.getByText("This value has line breaks. Turn on Multiline to keep them.")).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Turn on Multiline" }));
    expect(screen.queryByText("This value has line breaks. Turn on Multiline to keep them.")).toBeNull();
    expect(saveBtn().disabled).toBe(false);
  });

  it("reveal state follows the row through sort and delete when rows carry flags", async () => {
    setup({ ZED: "1", ALPHA: "2" }, flagsResp({ ZED: view({ literal: true }) }, { buildTime: true, literal: true }));
    await screen.findByDisplayValue("1");
    fireEvent.click(screen.getAllByRole("button", { name: "Reveal value" })[1]); // ALPHA
    fireEvent.click(screen.getByRole("button", { name: "Sort A-Z" }));
    const keys = (screen.getAllByLabelText("Key") as HTMLInputElement[]).map((e) => e.value);
    expect(keys).toEqual(["ALPHA", "ZED"]);
    expect(vals("Value")).toEqual(["text", "password"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]); // delete ALPHA
    expect(vals("Value")).toEqual(["password"]);
    expect(screen.getByText("Literal")).toBeTruthy(); // ZED's flags stayed on ZED
  });

  it("a server 400 shows the server's message under the card", async () => {
    const { setAppEnv } = setup({ A: "x" });
    setAppEnv.mockRejectedValue(new ApiError(400, "variable LD_PRELOAD: a multiline variable name must use letters"));
    await screen.findByDisplayValue("x");
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "y" } });
    fireEvent.click(saveBtn());
    expect(await screen.findByText(/Could not save the environment variables: variable LD_PRELOAD/)).toBeTruthy();
  });

  it("a read-only viewer sees chips but cannot change the flags", async () => {
    setup({ PEM: "a\nb" }, flagsResp({ PEM: view({ multiline: true }) }), false);
    await screen.findByTestId("env-ml-masked");
    fireEvent.click(screen.getByRole("button", { name: "Variable options" }));
    expect((screen.getByLabelText("Multiline value") as HTMLInputElement).disabled).toBe(true);
  });
});
