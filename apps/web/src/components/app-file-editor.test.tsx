import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { AppFileEditor } from "./app-file-editor";
import { ApiError } from "../lib/api";
import { NotEditableError, readFileText, uploadFile } from "../lib/files-api";
import { DeleteConfirmDialog } from "./app-file-dialogs";

vi.mock("../lib/files-api", async (importOriginal) => {
  const m = await importOriginal<typeof import("../lib/files-api")>();
  return { ...m, readFileText: vi.fn(), uploadFile: vi.fn() };
});

afterEach(cleanup);
beforeEach(() => {
  (readFileText as Mock).mockReset();
  (uploadFile as Mock).mockReset();
  vi.restoreAllMocks();
});

const target = { scope: "volume" as const, name: "data" };
const mount = (over: Partial<React.ComponentProps<typeof AppFileEditor>> = {}) => {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <I18nProvider>
      <AppFileEditor id="a1" target={target} path="d/n.txt" name="n.txt" maxEditBytes={4096} writable onClose={onClose} onSaved={onSaved} {...over} />
    </I18nProvider>,
  );
  return { onClose, onSaved };
};
const box = () => screen.getByRole("textbox", { name: "Editing n.txt" }) as HTMLTextAreaElement;
/** A failed upload; the rejection is pre-handled so it never surfaces as unhandled before the editor attaches. */
const fail = (e: unknown) => {
  const promise = Promise.reject(e);
  promise.catch(() => undefined);
  return { promise, abort: vi.fn() };
};
const ok = (etag = "5-1") => ({ promise: Promise.resolve({ path: "d/n.txt", bytes: 5, sha256: "x", etag, created: false }), abort: vi.fn() });

describe("AppFileEditor", () => {
  it("loads the file with its ETag and saves with ifMatch + overwrite, preserving the trailing newline exactly", async () => {
    (readFileText as Mock).mockResolvedValue({ text: "hello\n", etag: "6-100", crlf: false });
    (uploadFile as Mock).mockReturnValue(ok("9-200"));
    const { onSaved } = mount();
    await waitFor(() => expect(box().value).toBe("hello\n"));
    expect(readFileText).toHaveBeenCalledWith("a1", target, "d/n.txt", 4096);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true); // not dirty
    fireEvent.change(box(), { target: { value: "hello world\n" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    const o = (uploadFile as Mock).mock.calls[0][0];
    expect(o).toMatchObject({ id: "a1", target, path: "d/n.txt", overwrite: true, ifMatch: "6-100" });
    expect(await (o.body as Blob).text()).toBe("hello world\n"); // trailing newline kept exactly
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await screen.findByText("Saved")).toBeTruthy();
    // the next save uses the NEW etag
    fireEvent.change(box(), { target: { value: "again" } });
    (uploadFile as Mock).mockReturnValue(ok("5-300"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    expect((uploadFile as Mock).mock.calls[1][0].ifMatch).toBe("9-200");
    expect(await ((uploadFile as Mock).mock.calls[1][0].body as Blob).text()).toBe("again"); // and no newline is invented
  });

  it("restores CRLF line breaks on save for a CRLF file", async () => {
    (readFileText as Mock).mockResolvedValue({ text: "a\nb\n", etag: "6-1", crlf: true });
    (uploadFile as Mock).mockReturnValue(ok());
    mount();
    await waitFor(() => expect(box().value).toBe("a\nb\n"));
    fireEvent.change(box(), { target: { value: "a\nb\nc\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    expect(await ((uploadFile as Mock).mock.calls[0][0].body as Blob).text()).toBe("a\r\nb\r\nc\r\n");
  });

  it("Ctrl/Cmd+S saves", async () => {
    (readFileText as Mock).mockResolvedValue({ text: "x", etag: "1-1", crlf: false });
    (uploadFile as Mock).mockReturnValue(ok());
    mount();
    await waitFor(() => expect(box().value).toBe("x"));
    fireEvent.change(box(), { target: { value: "xy" } });
    fireEvent.keyDown(box(), { key: "s", ctrlKey: true });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    fireEvent.change(box(), { target: { value: "xyz" } });
    fireEvent.keyDown(box(), { key: "S", metaKey: true });
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["binary", /binary file/],
    ["tooBig", /too large to edit/],
    ["encoding", /isn't valid UTF-8/],
    ["lineEndings", /mixes line-ending styles/],
  ] as const)("refuses %s content with a 'download instead' link and no editor", async (reason, text) => {
    (readFileText as Mock).mockRejectedValue(new NotEditableError(reason));
    mount();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe("/api/v1/apps/a1/files/content?volume=data&path=d%2Fn.txt");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("a 412 changed shows a Reload / Overwrite-anyway bar; Overwrite anyway re-saves WITHOUT ifMatch", async () => {
    (readFileText as Mock).mockResolvedValue({ text: "mine", etag: "4-1", crlf: false });
    (uploadFile as Mock).mockReturnValueOnce(fail(new ApiError(412, "changed", "changed")));
    mount();
    await waitFor(() => expect(box().value).toBe("mine"));
    fireEvent.change(box(), { target: { value: "mine!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("This file changed since you opened it.")).toBeTruthy();
    expect((uploadFile as Mock).mock.calls[0][0].ifMatch).toBe("4-1");
    (uploadFile as Mock).mockReturnValueOnce(ok("5-9"));
    fireEvent.click(screen.getByRole("button", { name: "Overwrite anyway" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    expect((uploadFile as Mock).mock.calls[1][0].ifMatch).toBeUndefined();
    await waitFor(() => expect(screen.queryByText("This file changed since you opened it.")).toBeNull());
  });

  it("Reload on a conflict re-reads the file (taking the on-disk version)", async () => {
    (readFileText as Mock).mockResolvedValueOnce({ text: "mine", etag: "4-1", crlf: false }).mockResolvedValueOnce({ text: "theirs", etag: "6-2", crlf: false });
    (uploadFile as Mock).mockReturnValueOnce(fail(new ApiError(412, "changed", "changed")));
    mount();
    await waitFor(() => expect(box().value).toBe("mine"));
    fireEvent.change(box(), { target: { value: "mine!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(box().value).toBe("theirs"));
  });

  it("guards unsaved edits when closing, and closes freely when clean", async () => {
    (readFileText as Mock).mockResolvedValue({ text: "x", etag: "1-1", crlf: false });
    const confirm = vi.spyOn(window, "confirm");
    const { onClose } = mount();
    await waitFor(() => expect(box().value).toBe("x"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.change(box(), { target: { value: "xx" } });
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(confirm).toHaveBeenCalledWith("Discard your unsaved changes?");
    expect(onClose).toHaveBeenCalledTimes(1);
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("a brand-new file starts empty, never reads, and is created (no overwrite, no ifMatch) on first save", async () => {
    (uploadFile as Mock).mockReturnValue(ok("0-1"));
    mount({ isNew: true });
    expect(readFileText).not.toHaveBeenCalled();
    expect(box().value).toBe("");
    fireEvent.change(box(), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    expect((uploadFile as Mock).mock.calls[0][0]).toMatchObject({ overwrite: false, ifMatch: undefined });
    // after the create, further saves replace the file it just made
    fireEvent.change(box(), { target: { value: "second" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    expect((uploadFile as Mock).mock.calls[1][0]).toMatchObject({ overwrite: true, ifMatch: "0-1" });
  });

  it("creating over an existing name shows the typed error", async () => {
    (uploadFile as Mock).mockReturnValue(fail(new ApiError(409, "x", "exists")));
    mount({ isNew: true });
    fireEvent.change(box(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Something with that name already exists.")).toBeTruthy();
  });

  it("a running datastore asks for the acknowledgement and retries with it", async () => {
    (readFileText as Mock).mockResolvedValue({ text: "x", etag: "1-1", crlf: false });
    (uploadFile as Mock)
      .mockReturnValueOnce(fail(new ApiError(409, "risky", "datastore_running")))
      .mockReturnValueOnce(ok());
    const requestAck = vi.fn().mockResolvedValue(true);
    mount({ requestAck });
    await waitFor(() => expect(box().value).toBe("x"));
    fireEvent.change(box(), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(2));
    expect(requestAck).toHaveBeenCalledTimes(1);
    expect((uploadFile as Mock).mock.calls[1][0].acknowledgeRisk).toBe(true);
  });

  it("read-only mode shows the content but offers no Save", async () => {
    (readFileText as Mock).mockResolvedValue({ text: "x", etag: "1-1", crlf: false });
    mount({ writable: false });
    await waitFor(() => expect(box().value).toBe("x"));
    expect(box().readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("a load failure shows the typed message and a retry", async () => {
    (readFileText as Mock).mockRejectedValueOnce(new ApiError(404, "x", "not_found")).mockResolvedValueOnce({ text: "back", etag: "1-1", crlf: false });
    mount();
    expect(await screen.findByText("That file or folder no longer exists.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(box().value).toBe("back"));
  });
});

describe("DeleteConfirmDialog (not_empty path)", () => {
  it("a not-empty answer re-asks with the recursive wording and the typed-name guard", () => {
    const onConfirm = vi.fn();
    render(
      <I18nProvider>
        <DeleteConfirmDialog name="cache" isDir={false} notEmpty onConfirm={onConfirm} onClose={() => undefined} />
      </I18nProvider>,
    );
    expect(screen.getByText("The folder isn't empty. Delete it and everything inside it?")).toBeTruthy();
    const del = screen.getAllByRole("button", { name: "Delete" }).find((b) => b.closest("[role=dialog]")) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type cache to confirm"), { target: { value: "cache" } });
    fireEvent.click(del);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });
});
