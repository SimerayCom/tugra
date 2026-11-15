import { describe, it, expect, vi, afterEach, beforeEach, type Mock } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { AppFilesCard } from "./app-files-card";
import { api, ApiError } from "../lib/api";
import { UploadAbortedError, filesApi, uploadFile, type FilesMeta } from "../lib/files-api";
import type { AppVolume, FileListing } from "../lib/types";

vi.mock("../lib/files-api", async (importOriginal) => {
  const m = await importOriginal<typeof import("../lib/files-api")>();
  return { ...m, uploadFile: vi.fn() };
});

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
  (uploadFile as Mock).mockReset();
});
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

const VOL: AppVolume[] = [{ name: "data", path: "/data" }];
const listing = (over: Partial<FileListing> = {}): FileListing => ({
  entries: [
    { name: "readme.txt", type: "file", size: 2048, mode: "rw-r--r--", mtime: 1 },
    { name: "sub", type: "dir", size: 0, mode: "rwxr-xr-x", mtime: 2 },
    { name: "link", type: "symlink", size: 0, mode: "rwxrwxrwx", mtime: 3 },
  ],
  truncated: false,
  ...over,
});

function meta(over: Partial<FilesMeta> = {}): FilesMeta {
  return {
    serverOnline: true,
    clustered: false,
    capabilities: { files: true, filesWrite: true, terminal: true },
    canTerminal: true,
    agentSupportsFs2: true,
    datastore: false,
    volumes: [{ name: "data", writable: true }],
    container: { available: true, writable: true, names: ["tugra_a1"] },
    limits: { maxUploadBytes: 1000, maxDownloadBytes: 10_000, maxEditBytes: 4096 },
    ...over,
  };
}

function setup(m: FilesMeta | Error = meta(), l: FileListing = listing(), props: { canWrite?: boolean; serverId?: string } = { canWrite: true }) {
  const list = vi.spyOn(api, "listAppFiles").mockResolvedValue(l);
  const metaSpy = vi.spyOn(filesApi, "filesMeta");
  if (m instanceof Error) metaSpy.mockRejectedValue(m);
  else metaSpy.mockResolvedValue(m);
  wrap(<AppFilesCard id="a1" volumes={VOL} {...props} />);
  return { list, metaSpy };
}

const row = async (name: string) => (await screen.findByText(name)).closest("div[style]") as HTMLElement;
async function openMenu(name: string, item: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("AppFilesCard write gating", () => {
  it("renders NO write controls and never asks for meta without canWrite (read-only browser)", async () => {
    const { metaSpy } = setup(meta(), listing(), {});
    await screen.findByText("sub");
    expect(metaSpy).not.toHaveBeenCalled();
    for (const n of ["New file", "New folder", "Upload", "Refresh"]) expect(screen.queryByRole("button", { name: n })).toBeNull();
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("falls back to the read-only browser when the meta call fails", async () => {
    setup(new ApiError(500, "boom"));
    await screen.findByText("sub");
    await waitFor(() => expect(screen.queryByRole("button", { name: "New file" })).toBeNull());
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
  });

  it("shows the write toolbar only when canWrite AND meta says the volume is writable", async () => {
    setup();
    for (const n of ["Refresh", "New file", "New folder", "Upload"]) expect(await screen.findByRole("button", { name: n })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Actions for/ }).length).toBe(3);
  });

  it.each([
    ["files not granted", { capabilities: { files: false, filesWrite: false, terminal: false } }, /File access isn't enabled/],
    ["files_write not granted", { capabilities: { files: true, filesWrite: false, terminal: true }, volumes: [{ name: "data", writable: false, reason: "capability" as const }] }, /Read-only: file changes aren't enabled/],
    ["agent too old", { agentSupportsFs2: false, volumes: [{ name: "data", writable: false, reason: "agent_old" as const }] }, /agent is too old/],
    ["server offline", { serverOnline: false, volumes: [{ name: "data", writable: false, reason: "offline" as const }] }, /agent is offline/],
    ["deploy in progress", { volumes: [{ name: "data", writable: false, reason: "deploy_in_progress" as const }] }, /A deploy is running/],
    ["datastore running", { datastore: true, volumes: [{ name: "data", writable: true, reason: "datastore_running" as const }] }, /looks like a database or broker/],
    ["clustered", { clustered: true, container: { available: false, writable: false, reason: "clustered" as const, names: [] } }, /isn't available for clustered apps/],
    ["not deployed", { container: { available: false, writable: false, reason: "not_deployed" as const, names: [] } }, /available after the first deploy/],
    ["terminal permission missing", { canTerminal: false, container: { available: false, writable: false, reason: "permission" as const, names: [] } }, /terminal permission/],
    ["terminal capability missing", { capabilities: { files: true, filesWrite: true, terminal: false }, container: { available: false, writable: false, reason: "capability" as const, names: [] } }, /Terminal and Files capabilities/],
  ])("state panel: %s", async (_label, over, text) => {
    setup(meta(over as Partial<FilesMeta>));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("read-only state hides the write controls but keeps Refresh, and links to the server's capabilities", async () => {
    setup(meta({ capabilities: { files: true, filesWrite: false, terminal: false }, volumes: [{ name: "data", writable: false, reason: "capability" }], container: { available: false, writable: false, reason: "capability", names: [] } }), listing(), { canWrite: true, serverId: "srv9" });
    await screen.findByText(/Read-only: file changes aren't enabled/);
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New file" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    // Download only needs the `files` capability, so a read-only file still has it — and nothing that writes.
    expect(screen.getAllByRole("button", { name: /Actions for/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Actions for readme.txt" }));
    expect((await screen.findAllByRole("menuitem")).map((e) => e.textContent)).toEqual(["Download"]);
    expect(screen.getByRole("link", { name: "Open server capabilities" }).getAttribute("href")).toBe("/servers/srv9");
  });

  it("hides the helper's in-flight temp files", async () => {
    setup(meta(), listing({ entries: [{ name: ".tugra-part-0123456789abcdef", type: "file", size: 1, mode: "rw-------", mtime: 1 }, { name: "ok.txt", type: "file", size: 1, mode: "rw-r--r--", mtime: 1 }] }));
    await screen.findByText("ok.txt");
    expect(screen.queryByText(/\.tugra-part-/)).toBeNull();
  });

  it("offers per-entry actions by type: files get Edit/Download/Rename/Permissions/Delete, links only Rename/Delete, big files no Edit", async () => {
    setup(meta(), listing({ entries: [{ name: "big.bin", type: "file", size: 5000, mode: "rw-r--r--", mtime: 1 }, ...listing().entries] }));
    await screen.findByText("readme.txt");
    const items = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
      const menu = await screen.findByRole("menu", { name: `Actions for ${name}` });
      const labels = within(menu).getAllByRole("menuitem").map((e) => e.textContent);
      fireEvent.keyDown(menu, { key: "Escape" });
      return labels;
    };
    expect(await items("readme.txt")).toEqual(["Edit", "Download", "Rename", "Permissions", "Delete"]);
    expect(await items("big.bin")).toEqual(["Download", "Rename", "Permissions", "Delete"]); // > maxEditBytes
    expect(await items("sub")).toEqual(["Rename", "Permissions", "Delete"]);
    expect(await items("link")).toEqual(["Rename", "Delete"]);
  });
});

describe("AppFilesCard mutations", () => {
  it("creates a folder after validating the name, then refreshes the list", async () => {
    const { list } = setup();
    const mk = vi.spyOn(filesApi, "mkdir").mockResolvedValue({} as never);
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    const input = await screen.findByLabelText("Name");
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    for (const bad of ["a/b", "..", "."]) {
      fireEvent.change(input, { target: { value: bad } });
      expect(create.disabled).toBe(true);
      expect(screen.getByRole("alert").textContent).toMatch(/without slashes/);
    }
    fireEvent.change(input, { target: { value: "photos" } });
    expect(create.disabled).toBe(false);
    const before = list.mock.calls.length;
    fireEvent.click(create);
    await waitFor(() => expect(mk).toHaveBeenCalledWith("a1", { scope: "volume", name: "data" }, "photos", { acknowledgeRisk: false }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
  });

  it("creates the folder inside the folder you are in", async () => {
    setup();
    const mk = vi.spyOn(filesApi, "mkdir").mockResolvedValue({} as never);
    fireEvent.click(await screen.findByText("sub"));
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mk).toHaveBeenCalledWith("a1", expect.anything(), "sub/x", expect.anything()));
  });

  it("a new file opens the (empty) editor instead of calling the API", async () => {
    setup();
    const mk = vi.spyOn(filesApi, "mkdir");
    fireEvent.click(await screen.findByRole("button", { name: "New file" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "notes.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("dialog", { name: "Editing notes.txt" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Editing notes.txt" }) as HTMLTextAreaElement).value).toBe("");
    expect(mk).not.toHaveBeenCalled();
  });

  it("renames within the same folder", async () => {
    setup();
    const rn = vi.spyOn(filesApi, "rename").mockResolvedValue({} as never);
    await openMenu("readme.txt", "Rename");
    const input = await screen.findByLabelText("New name");
    const submit = screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // unchanged name
    fireEvent.change(input, { target: { value: "a/b" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "README.md" } });
    fireEvent.click(submit);
    await waitFor(() => expect(rn).toHaveBeenCalledWith("a1", { scope: "volume", name: "data" }, "readme.txt", "README.md", { acknowledgeRisk: false }));
  });

  it("shows the server's typed error inside the dialog and keeps it open", async () => {
    setup();
    vi.spyOn(filesApi, "rename").mockRejectedValue(new ApiError(409, "x", "exists"));
    await openMenu("readme.txt", "Rename");
    fireEvent.change(await screen.findByLabelText("New name"), { target: { value: "sub" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByText("Something with that name already exists.")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("permissions: loads the mode via stat, keeps the grid and octal input in sync, refuses setuid/sticky", async () => {
    setup();
    vi.spyOn(filesApi, "statFile").mockResolvedValue({ mode: "0644" } as never);
    const ch = vi.spyOn(filesApi, "chmod").mockResolvedValue({} as never);
    await openMenu("readme.txt", "Permissions");
    const octal = (await screen.findByLabelText("Octal mode")) as HTMLInputElement;
    expect(octal.value).toBe("0644");
    const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
    expect(box("Owner Write").checked).toBe(true);
    expect(box("Everyone Write").checked).toBe(false);
    fireEvent.click(box("Everyone Execute")); // grid -> octal
    expect(octal.value).toBe("0645");
    fireEvent.change(octal, { target: { value: "0750" } }); // octal -> grid
    expect(box("Group Execute").checked).toBe(true);
    expect(box("Everyone Read").checked).toBe(false);
    fireEvent.change(octal, { target: { value: "4755" } }); // 4 digits but > 0777
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(octal, { target: { value: "75" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(octal, { target: { value: "0640" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ch).toHaveBeenCalledWith("a1", expect.anything(), "readme.txt", "0640", { acknowledgeRisk: false }));
  });

  it("deleting a file is a simple, non-recursive confirm that says no snapshot is taken", async () => {
    setup();
    const del = vi.spyOn(filesApi, "deleteEntry").mockResolvedValue(undefined as never);
    await openMenu("readme.txt", "Delete");
    expect(await screen.findByText(/no snapshot is taken/)).toBeTruthy();
    expect(screen.queryByLabelText(/Type readme.txt/)).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("a1", expect.anything(), "readme.txt", { recursive: false, acknowledgeRisk: false }));
  });

  it("deleting a folder is recursive and needs its name typed", async () => {
    setup();
    const del = vi.spyOn(filesApi, "deleteEntry").mockResolvedValue(undefined as never);
    await openMenu("sub", "Delete");
    const confirm = within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const typed = screen.getByLabelText("Type sub to confirm");
    fireEvent.change(typed, { target: { value: "su" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(typed, { target: { value: "sub" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(del).toHaveBeenCalledWith("a1", expect.anything(), "sub", { recursive: true, acknowledgeRisk: false }));
  });

  it("a running datastore: the 409 asks for the acknowledgement, then retries once with acknowledgeRisk", async () => {
    setup();
    const mk = vi
      .spyOn(filesApi, "mkdir")
      .mockRejectedValueOnce(new ApiError(409, "risky", "datastore_running"))
      .mockResolvedValue({} as never);
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const ack = await screen.findByRole("dialog", { name: "Change a running datastore?" });
    const retry = within(ack).getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true); // must tick the box first
    fireEvent.click(within(ack).getByLabelText("I understand the risk"));
    fireEvent.click(retry);
    await waitFor(() => expect(mk).toHaveBeenCalledTimes(2));
    expect(mk.mock.calls[0][3]).toEqual({ acknowledgeRisk: false });
    expect(mk.mock.calls[1][3]).toEqual({ acknowledgeRisk: true });
  });

  it("declining the datastore acknowledgement leaves everything untouched", async () => {
    setup();
    const mk = vi.spyOn(filesApi, "mkdir").mockRejectedValue(new ApiError(409, "risky", "datastore_running"));
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Change a running datastore?" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Change a running datastore?" })).toBeNull());
    expect(mk).toHaveBeenCalledTimes(1);
  });
});

/** A controllable stand-in for uploadFile: each call yields a handle the test resolves/rejects. */
function fakeUploads() {
  const calls: { o: Parameters<typeof uploadFile>[0]; resolve: (v?: unknown) => void; reject: (e: unknown) => void; abort: Mock }[] = [];
  (uploadFile as Mock).mockImplementation((o: Parameters<typeof uploadFile>[0]) => {
    let resolve!: (v?: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    const abort = vi.fn(() => reject(new UploadAbortedError()));
    calls.push({ o, resolve, reject, abort });
    return { promise, abort };
  });
  return calls;
}
const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);
async function pick(files: File[]) {
  const input = (await screen.findByLabelText("Choose files to upload to this folder, or drop them here.")) as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

describe("AppFilesCard uploads", () => {
  it("uploads picked files into the current folder with per-file progress, then refreshes the list", async () => {
    const { list } = setup();
    const calls = fakeUploads();
    await screen.findByText("sub");
    fireEvent.click(screen.getByText("sub"));
    await waitFor(() => expect(list).toHaveBeenCalledWith("a1", "data", "sub"));
    const before = list.mock.calls.length;
    await pick([file("a.txt", 100)]);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].o).toMatchObject({ id: "a1", path: "sub/a.txt", overwrite: false, target: { scope: "volume", name: "data" } });
    act(() => calls[0].o.onProgress?.(40, 100));
    expect(await screen.findByText("Uploading 40%")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "a.txt" }).getAttribute("aria-valuenow")).toBe("40");
    act(() => calls[0].o.onProgress?.(100, 100));
    expect(await screen.findByText("Applying on the server…")).toBeTruthy();
    await act(async () => calls[0].resolve({ created: true }));
    expect(await screen.findByText("Uploaded")).toBeTruthy();
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(before));
  });

  it("runs at most 3 uploads in parallel and starts the next as one finishes", async () => {
    setup();
    const calls = fakeUploads();
    await pick(["1", "2", "3", "4", "5"].map((n) => file(`f${n}.txt`)));
    await waitFor(() => expect(calls).toHaveLength(3));
    await act(async () => calls[0].resolve({ created: true }));
    await waitFor(() => expect(calls).toHaveLength(4));
    await act(async () => calls[1].resolve({ created: true }));
    await act(async () => calls[2].resolve({ created: true }));
    await waitFor(() => expect(calls).toHaveLength(5));
    expect(calls.map((c) => c.o.path)).toEqual(["f1.txt", "f2.txt", "f3.txt", "f4.txt", "f5.txt"]);
  });

  it("refuses a file over the size limit client-side (no request) and shows why", async () => {
    setup(); // maxUploadBytes = 1000
    const calls = fakeUploads();
    await pick([file("huge.bin", 5000)]);
    expect(await screen.findByText(/Larger than the .* upload limit/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Retry upload of huge.bin" })).toBeNull(); // nothing to retry
  });

  it("409 exists opens Overwrite / Skip; Overwrite retries with overwrite=1", async () => {
    setup();
    const calls = fakeUploads();
    await pick([file("a.txt")]);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0].reject(new ApiError(409, "exists", "exists")));
    const dlg = await screen.findByRole("dialog", { name: "Overwrite" });
    expect(within(dlg).getByText("a.txt already exists in this folder. Overwrite it?")).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].o.overwrite).toBe(true);
  });

  it("409 exists -> Skip drops the file without a second request", async () => {
    setup();
    const calls = fakeUploads();
    await pick([file("a.txt")]);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0].reject(new ApiError(409, "exists", "exists")));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Overwrite" })).getByRole("button", { name: "Skip" }));
    expect(await screen.findByText("Skipped")).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  it("409 datastore_running asks for the acknowledgement and retries with acknowledgeRisk=1", async () => {
    setup();
    const calls = fakeUploads();
    await pick([file("a.txt")]);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0].reject(new ApiError(409, "risky", "datastore_running")));
    const dlg = await screen.findByRole("dialog", { name: "Change a running datastore?" });
    fireEvent.click(within(dlg).getByLabelText("I understand the risk"));
    fireEvent.click(within(dlg).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].o.acknowledgeRisk).toBe(true);
  });

  it.each([
    [new ApiError(413, "x", "too_large"), "That is larger than the allowed size."],
    [new ApiError(507, "x", "staging_full"), "There isn't enough free space."],
    [new ApiError(403, "x", "denied"), "Permission denied. The server refused that change."],
    [new ApiError(412, "x", "changed"), "It changed since you opened it. Reload or overwrite."],
  ])("maps a failed upload (%#) to a readable, retryable row", async (err, text) => {
    setup();
    const calls = fakeUploads();
    await pick([file("a.txt")]);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0].reject(err));
    expect(await screen.findByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry upload of a.txt" }));
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("a 429 (rate limit / busy) retries by itself after Retry-After instead of failing the file", async () => {
    setup();
    const calls = fakeUploads();
    await pick([file("a.txt")]);
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => calls[0].reject(new ApiError(429, "slow down", "rate_limited", { retryAfterSec: 0.1 })));
    expect(await screen.findByText(/Retrying in \d+s/)).toBeTruthy();
    expect(screen.queryByText("Failed")).toBeNull();
    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 2000 });
    await act(async () => calls[1].reject(new ApiError(429, "busy", "busy"))); // busy => 3 s default backoff
    expect(await screen.findByText(/Retrying in \d+s/)).toBeTruthy();
    expect(calls).toHaveLength(2); // not before the backoff elapses
  });

  it("cancel aborts an in-flight upload and removes its row", async () => {
    setup();
    const calls = fakeUploads();
    await pick([file("a.txt")]);
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of a.txt" }));
    expect(calls[0].abort).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("progressbar", { name: "a.txt" })).toBeNull());
  });

  it("cancelling a queued upload (never started) just removes it", async () => {
    setup();
    const calls = fakeUploads();
    await pick(["1", "2", "3", "4"].map((n) => file(`q${n}.txt`)));
    await waitFor(() => expect(calls).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of q4.txt" }));
    await waitFor(() => expect(screen.queryByRole("progressbar", { name: "q4.txt" })).toBeNull());
    expect(calls).toHaveLength(3);
  });

  it("drag-and-drop shows the drop overlay and uploads the dropped files", async () => {
    setup();
    const calls = fakeUploads();
    const zone = (await screen.findByText("sub")).closest("[aria-busy]") as HTMLElement;
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(await screen.findByText("Drop to upload to /")).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [file("dropped.txt")] } });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].o.path).toBe("dropped.txt");
    expect(screen.queryByText("Drop to upload to /")).toBeNull();
  });

  it("ignores a non-file drag, and drops entirely when the volume is not writable", async () => {
    setup(meta({ volumes: [{ name: "data", writable: false, reason: "capability" }] }));
    const calls = fakeUploads();
    const zone = (await screen.findByText("sub")).closest("[aria-busy]") as HTMLElement;
    await waitFor(() => expect(screen.queryByRole("button", { name: "Upload" })).toBeNull());
    fireEvent.dragEnter(zone, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.queryByText(/Drop to upload/)).toBeNull();
    // the drop is still CANCELLED (fireEvent returns false when preventDefault ran), so the browser never navigates
    // to the dropped file — but nothing is queued
    expect(fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [file("x.txt")] } })).toBe(false);
    expect(fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], files: [] } })).toBe(false);
    expect(calls).toHaveLength(0);
    // a non-file drag (text, a link) is left alone
    expect(fireEvent.drop(zone, { dataTransfer: { types: ["text/plain"], files: [] } })).toBe(true);
  });
});

describe("AppFilesCard container filesystem", () => {
  it("offers the source switcher only when the container FS is available", async () => {
    setup(meta({ container: { available: false, writable: false, reason: "permission", names: [] } }));
    await screen.findByText("sub");
    expect(screen.queryByRole("group", { name: "Source" })).toBeNull();
  });

  it("switches to the container: ephemeral banner, path field with Enter navigation, quick links, truncation banner", async () => {
    setup();
    const lc = vi.spyOn(filesApi, "listContainerFiles").mockResolvedValue({ entries: [{ name: "x.conf", type: "file", size: 1, mode: "rw-r--r--", mtime: 1 }], truncated: true });
    fireEvent.click(await screen.findByRole("button", { name: "Container (ephemeral)" }));
    await waitFor(() => expect(lc).toHaveBeenCalledWith("a1", "tugra_a1", "/app"));
    expect(await screen.findByText(/live container filesystem\. Changes are lost/)).toBeTruthy(); // persistent banner
    expect(await screen.findByText(/too large to list completely/)).toBeTruthy();
    expect(screen.getByText(/need mv, chmod and rm inside the image/)).toBeTruthy();
    const field = screen.getByLabelText("Path") as HTMLInputElement;
    expect(field.value).toBe("/app");
    fireEvent.change(field, { target: { value: "/etc/nginx" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(lc).toHaveBeenCalledWith("a1", "tugra_a1", "/etc/nginx"));
    fireEvent.click(screen.getByRole("button", { name: "/etc" }));
    await waitFor(() => expect(lc).toHaveBeenCalledWith("a1", "tugra_a1", "/etc"));
    expect((screen.getByLabelText("Path") as HTMLInputElement).value).toBe("/etc");
    // a relative path typed into the field is ignored
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "relative" } });
    fireEvent.keyDown(screen.getByLabelText("Path"), { key: "Enter" });
    expect(lc).not.toHaveBeenCalledWith("a1", "tugra_a1", "relative");
  });

  it("container writes use the container target and the persistent warning stays visible", async () => {
    setup();
    vi.spyOn(filesApi, "listContainerFiles").mockResolvedValue({ entries: [{ name: "x.conf", type: "file", size: 1, mode: "rw-r--r--", mtime: 1 }], truncated: false });
    const mk = vi.spyOn(filesApi, "mkdir").mockResolvedValue({} as never);
    fireEvent.click(await screen.findByRole("button", { name: "Container (ephemeral)" }));
    await screen.findByText("x.conf");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "d" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mk).toHaveBeenCalledWith("a1", { scope: "container", name: "tugra_a1" }, "/app/d", { acknowledgeRisk: false }));
    expect(screen.getByText(/Changes are lost when the container is recreated/)).toBeTruthy();
  });

  it("a read-only container (no files_write) lists but offers no write controls", async () => {
    setup(meta({ capabilities: { files: true, filesWrite: false, terminal: true }, volumes: [{ name: "data", writable: false, reason: "capability" }], container: { available: true, writable: false, reason: "capability", names: ["tugra_a1"] } }));
    vi.spyOn(filesApi, "listContainerFiles").mockResolvedValue({ entries: [{ name: "x.conf", type: "file", size: 1, mode: "rw-r--r--", mtime: 1 }], truncated: false });
    fireEvent.click(await screen.findByRole("button", { name: "Container (ephemeral)" }));
    await screen.findByText("x.conf");
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for x.conf" }));
    expect((await screen.findAllByRole("menuitem")).map((e) => e.textContent)).toEqual(["Download"]);
  });

  it("a COMPOSE app (no single container) lets you pick one of its containers", async () => {
    setup(meta({ container: { available: true, writable: true, names: [] } }));
    vi.spyOn(api, "listAppContainers").mockResolvedValue({ containers: [{ name: "tugra_a1-web-1", state: "running" }, { name: "tugra_a1-db-1", state: "running" }] });
    const lc = vi.spyOn(filesApi, "listContainerFiles").mockResolvedValue({ entries: [], truncated: false });
    fireEvent.click(await screen.findByRole("button", { name: "Container (ephemeral)" }));
    await waitFor(() => expect(lc).toHaveBeenCalledWith("a1", "tugra_a1-web-1", "/app"));
    fireEvent.change(await screen.findByLabelText("Container"), { target: { value: "tugra_a1-db-1" } });
    await waitFor(() => expect(lc).toHaveBeenCalledWith("a1", "tugra_a1-db-1", "/"));
  });
});
