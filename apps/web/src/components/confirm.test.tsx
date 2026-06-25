import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider, useConfirm } from "./confirm";

afterEach(cleanup);

function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button onClick={async () => onResult(await confirm({ body: "Delete this?" }))}>trigger</button>
  );
}

const wrap = (onResult: (v: boolean) => void) =>
  render(
    <I18nProvider>
      <ConfirmProvider>
        <Harness onResult={onResult} />
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
});
