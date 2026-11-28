import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import type { MigrationRunExactImage, MigrationRunSafetyHints } from "../../lib/types";

vi.mock("../toast", () => ({ useToast: () => vi.fn() }));

import { ExactImagesSection } from "./exact-images-section";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const row = (over: Partial<MigrationRunExactImage> = {}): MigrationRunExactImage => ({ itemRef: "app:s:a", name: "search", member: "", ref: `getmeili/meilisearch:latest@${D1}`, tag: "latest", version: "1.12.3", digest: D1, kept: true, ...over });
const hints = (over: Partial<MigrationRunSafetyHints> = {}): MigrationRunSafetyHints => ({ imagePins: [], workerMarks: [], warningAcks: [], exactImages: [row()], exactUnknown: [], ...over });

const show = (h: MigrationRunSafetyHints, closed = false, onSaved = vi.fn()) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <I18nProvider><ExactImagesSection runId="r1" hints={h} closed={closed} onSaved={onSaved} /></I18nProvider>
    </QueryClientProvider>,
  );

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe("ExactImagesSection: Tugra keeps the exact image each item runs", () => {
  it("says it keeps the image and upgrades nothing, and shows per item the image the source runs: tag, version and short digest", () => {
    show(hints());
    expect(screen.getByText(/Tugra keeps the exact image each app, database and service runs\. Nothing is upgraded during the move\./)).toBeTruthy();
    expect(screen.getByText("Pinned to the image the source runs: latest (1.12.3), sha256:111111111111")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Keep the exact image of search" }) as HTMLInputElement).checked).toBe(true);
  });

  it("a database on a moving tag and a stack member are listed the same way; an image with no version label has no parentheses", () => {
    show(hints({ exactImages: [row({ itemRef: "database:s:d", name: "orders", ref: `postgres:16-alpine@${D2}`, tag: "16-alpine", version: null, digest: D2 }), row({ itemRef: "service:s:z", name: "search stack", member: "meili", version: "1.12.3" }), row({ itemRef: "service:s:z", name: "search stack", member: "redis", ref: `redis:7.2@${D2}`, tag: "7.2", version: null, digest: D2 })] }));
    expect(screen.getByText("Pinned to the image the source runs: 16-alpine, sha256:222222222222")).toBeTruthy();
    expect(screen.getByText("meili")).toBeTruthy();
    expect(screen.getByText("redis")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2); // the stack is one item, with one box
  });

  it("an image pinned only by the version it labels has no digest in the line", () => {
    show(hints({ exactImages: [row({ ref: "minio/minio:RELEASE.2024-05-10", tag: "RELEASE.2024-05-10", version: "RELEASE.2024-05-10", digest: null })] }));
    expect(screen.getByText("Pinned to the image the source runs: RELEASE.2024-05-10")).toBeTruthy();
  });

  it("unticking an item sends keep:false for that item only, and the answer is handed back", async () => {
    const next = hints({ exactImages: [row({ kept: false })] });
    const put = vi.spyOn(api, "setMigrationRunExactImages").mockResolvedValue(next);
    const onSaved = vi.fn();
    show(hints(), false, onSaved);
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep the exact image of search" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("r1", { items: [{ itemRef: "app:s:a", keep: false }] }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(next));
  });

  it("an unticked item says it runs whatever its tag points at, and ticking it again sends keep:true", async () => {
    const put = vi.spyOn(api, "setMigrationRunExactImages").mockResolvedValue(hints());
    show(hints({ exactImages: [row({ kept: false })] }));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Not kept: this runs whatever its tag points at when it is deployed.")).toBeTruthy();
    expect(screen.queryByText(/Pinned to the image the source runs/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(put).toHaveBeenCalledWith("r1", { items: [{ itemRef: "app:s:a", keep: true }] }));
  });

  it("a run that can no longer take changes shows the boxes but cannot change them", () => {
    show(hints(), true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });

  it("an item the source host reported nothing for is listed as unknown with the image it keeps; with nothing recorded the screen says so", () => {
    show(hints({ exactImages: [], exactUnknown: [{ itemRef: "app:s:b", name: "worker", member: "", image: "x/b:2" }, { itemRef: "service:s:z", name: "search stack", member: "redis", image: "redis:7.2" }] }));
    expect(screen.getByText("Unknown: the source host did not report the exact image")).toBeTruthy();
    expect(screen.getByText("worker keeps the image as the source writes it (x/b:2).")).toBeTruthy();
    expect(screen.getByText("search stack / redis keeps the image as the source writes it (redis:7.2).")).toBeTruthy();
    cleanup();
    show(hints({ exactImages: [], exactUnknown: [] }));
    expect(screen.getByText(/No exact image is recorded yet/)).toBeTruthy();
  });

  it("a hub that predates exact images (no fields) shows the empty note and nothing breaks", () => {
    show({ imagePins: [], workerMarks: [], warningAcks: [] });
    expect(screen.getByText(/No exact image is recorded yet/)).toBeTruthy();
  });

  it("lists, named and with the reason, what started without the exact image the source runs", () => {
    show(hints({ exactSkipped: [{ itemRef: "database:s:d", name: "orders", kind: "database", reason: "no-inventory" }, { itemRef: "app:s:b", name: "worker", kind: "app", reason: "started" }] }));
    expect(screen.getByText("Started without the exact image the source runs")).toBeTruthy();
    expect(screen.getByText("orders: the source host's inventory had not arrived when it started.")).toBeTruthy();
    expect(screen.getByText("worker: it was already started before the exact image arrived.")).toBeTruthy();
    cleanup();
    show(hints({ exactImages: [], exactSkipped: [{ itemRef: "database:s:d", name: "orders", kind: "database", reason: "refused" }] }));
    expect(screen.queryByText(/No exact image is recorded yet/)).toBeNull(); // a warning is not "nothing recorded"
  });

  it("while the hub answers, the box shows what was asked for and says it is busy (a click is never a silent no-op)", async () => {
    let done: (v: MigrationRunSafetyHints) => void = () => undefined;
    vi.spyOn(api, "setMigrationRunExactImages").mockReturnValue(new Promise((r) => (done = r)));
    show(hints());
    const box = screen.getByRole("checkbox", { name: "Keep the exact image of search" }) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false));
    expect((screen.getByRole("checkbox") as HTMLInputElement).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    done(hints({ exactImages: [row({ kept: false })] }));
  });

  it("a failed save puts the box back to what the hub has", async () => {
    vi.spyOn(api, "setMigrationRunExactImages").mockRejectedValue(new Error("boom"));
    show(hints());
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true));
  });
});
