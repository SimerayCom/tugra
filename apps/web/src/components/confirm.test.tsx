import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider, useConfirm, type ConfirmOptions } from "./confirm";

afterEach(cleanup);

function Harness({ onResult, opts }: { onResult: (v: boolean) => void; opts?: ConfirmOptions }) {
  const confirm = useConfirm();
  return (
    <button onClick={async () => onResult(await confirm(opts ?? { body: "Delete this?" }))}>trigger</button>
  );
}

const wrap = (onResult: (v: boolean) => void, opts?: ConfirmOptions) =>
  render(
    <I18nProvider>
      <ConfirmProvider>
        <Harness onResult={onResult} opts={opts} />
      </ConfirmProvider>
    </I18nProvider>,
  );

describe("useConfirm / ConfirmProvider", () => {
  it("resolves true when Confirm is clicked", async () => {
    const onResult = vi.fn();
    wrap(onResult);
    fireEvent.click(screen.getByText("trigger"));
    expect(screen.getByText("Delete this?")).toBeTruthy(); // modal shown
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it("resolves false when Cancel is clicked and closes the modal", async () => {
    const onResult = vi.fn();
    wrap(onResult);
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(screen.queryByText("Delete this?")).toBeNull();
  });

  it("keeps Confirm disabled until the exact confirmText is typed", async () => {
    const onResult = vi.fn();
    wrap(onResult, { body: "Delete my-app?", confirmText: "my-app", danger: true });
    fireEvent.click(screen.getByText("trigger"));
    const confirmBtn = screen.getByText("Confirm") as HTMLButtonElement;
    const input = screen.getByLabelText("Type my-app to confirm.") as HTMLInputElement;
    expect(confirmBtn.disabled).toBe(true);
    // a near-miss stays disabled
    fireEvent.change(input, { target: { value: "my-ap" } });
    expect(confirmBtn.disabled).toBe(true);
    fireEvent.click(confirmBtn);
    expect(onResult).not.toHaveBeenCalled();
    // exact match enables and resolves true
    fireEvent.change(input, { target: { value: "my-app" } });
    expect(confirmBtn.disabled).toBe(false);
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it("confirms on Enter only once the typed name matches", async () => {
    const onResult = vi.fn();
    wrap(onResult, { body: "Delete db?", confirmText: "db" });
    fireEvent.click(screen.getByText("trigger"));
    const input = screen.getByLabelText("Type db to confirm.") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onResult).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "db" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });

  it("renders multiple opt-in checkboxes and writes each choice to its own ref", async () => {
    const onResult = vi.fn();
    const a = { current: false };
    const b = { current: false };
    wrap(onResult, { body: "Delete app?", checkbox: [{ label: "Keep volumes", ref: a }, { label: "Also remove images", ref: b }] });
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.click(screen.getByText("Also remove images"));
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    expect(a.current).toBe(false); // untouched
    expect(b.current).toBe(true); // ticked
  });

  it("resets the typed value between openings so a stale match can't leak through", async () => {
    const onResult = vi.fn();
    wrap(onResult, { body: "Delete x?", confirmText: "x" });
    // first open: type the match, then cancel
    fireEvent.click(screen.getByText("trigger"));
    fireEvent.change(screen.getByLabelText("Type x to confirm."), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Cancel"));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false));
    // reopen: the field is empty again and Confirm is disabled
    fireEvent.click(screen.getByText("trigger"));
    expect((screen.getByLabelText("Type x to confirm.") as HTMLInputElement).value).toBe("");
    expect((screen.getByText("Confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});
