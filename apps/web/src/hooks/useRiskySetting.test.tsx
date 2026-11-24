import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "../components/confirm";
import { ToastProvider } from "../components/toast";
import { useRiskySetting, type RiskySettingChange } from "./useRiskySetting";

afterEach(cleanup);

function Harness({ change, onDone }: { change: RiskySettingChange; onDone?: (ok: boolean) => void }) {
  const run = useRiskySetting();
  return <button onClick={async () => { const ok = await run(change); onDone?.(ok); }}>go</button>;
}
const wrap = (change: RiskySettingChange, onDone?: (ok: boolean) => void) =>
  render(
    <I18nProvider>
      <ConfirmProvider>
        <ToastProvider>
          <Harness change={change} onDone={onDone} />
        </ToastProvider>
      </ConfirmProvider>
    </I18nProvider>,
  );
const base = (over: Partial<RiskySettingChange> = {}): RiskySettingChange => ({
  risky: true,
  confirm: { title: "Sure?", body: "This hides things.", confirmLabel: "Do it" },
  apply: vi.fn().mockResolvedValue(undefined),
  undo: vi.fn().mockResolvedValue(undefined),
  doneMessage: "Changed",
  undoneMessage: "Reverted",
  ...over,
});

describe("useRiskySetting", () => {
  it("asks first, applies on confirm, then offers a one-click undo that reverts", async () => {
    const c = base();
    const done = vi.fn();
    wrap(c, done);
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByText("This hides things.")).toBeTruthy();
    expect(c.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Do it"));
    await waitFor(() => expect(screen.getByText("Changed")).toBeTruthy());
    expect(c.apply).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("Undo"));
    await waitFor(() => expect(screen.getByText("Reverted")).toBeTruthy());
    expect(c.undo).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the user cancels", async () => {
    const c = base();
    const done = vi.fn();
    wrap(c, done);
    fireEvent.click(screen.getByText("go"));
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(done).toHaveBeenCalledWith(false));
    expect(c.apply).not.toHaveBeenCalled();
    expect(screen.queryByText("Changed")).toBeNull();
  });

  it("skips the dialog for a non-risky change but still offers undo", async () => {
    const c = base({ risky: false });
    wrap(c);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByText("Changed")).toBeTruthy());
    expect(screen.queryByText("This hides things.")).toBeNull();
    expect(screen.getByText("Undo")).toBeTruthy();
  });

  it("reports a failed apply as an error toast with no undo", async () => {
    const c = base({ risky: false, apply: vi.fn().mockRejectedValue(new Error("nope")) });
    const done = vi.fn();
    wrap(c, done);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByText("nope")).toBeTruthy());
    expect(done).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Undo")).toBeNull();
  });

  it("surfaces a failing undo instead of swallowing it", async () => {
    const c = base({ risky: false, undo: vi.fn().mockRejectedValue(new Error("cannot undo")) });
    wrap(c);
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => fireEvent.click(screen.getByText("Undo")));
    await waitFor(() => expect(screen.getByText("cannot undo")).toBeTruthy());
  });
});
