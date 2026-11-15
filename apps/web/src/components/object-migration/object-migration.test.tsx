import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { ToastProvider } from "../toast";
import { BucketTable } from "./bucket-table";
import { FreezeAckDialog } from "./freeze-ack-dialog";
import { PhasePanel, type PhaseHandlers } from "./phase-panel";
import { ConfigCarry } from "./config-carry";
import { SourceDestinationForm } from "./source-destination-form";
import { api } from "../../lib/api";
import type { ObjectBucketView, ObjectMigrationView } from "../../lib/types";

afterEach(cleanup);
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><ToastProvider>{ui}</ToastProvider></I18nProvider></QueryClientProvider>);

const b = (over: Partial<ObjectBucketView> = {}): ObjectBucketView => ({
  idx: 0, srcBucket: "bk", dstBucket: "bk", exclude: [], selected: false, status: "PENDING", srcObjects: null, srcBytes: null, dstObjects: null, dstBytes: null, doneObjects: null, doneBytes: null,
  diffMissing: null, diffDiffer: null, diffExtra: null, versioning: null, configSummary: null, configStatus: null, lastError: null, startedAt: null, finishedAt: null, ...over,
});
const m = (over: Partial<ObjectMigrationView> = {}, buckets: ObjectBucketView[] = []): ObjectMigrationView => ({
  id: "m1", name: "m", teamId: "t", targetServerId: "s", status: "PREFLIGHTED", phase: null, srcEndpoint: "https://a", dstEndpoint: "https://b", preserve: true, removeExtraneous: false, mergeIntoExisting: false,
  cancelRequested: false, warnings: [], buckets, canWrite: true, createdAt: "", updatedAt: "", finishedAt: null, ...over,
});

describe("BucketTable", () => {
  const buckets = [b({ idx: 0, srcBucket: "db-declareall", srcBytes: 3_900_000_000, srcObjects: 120 }), b({ idx: 1, srcBucket: "uploads", srcBytes: 4_600_000_000, srcObjects: 90_000, dstObjects: 12 }), b({ idx: 2, srcBucket: "tiny", srcBytes: 5, srcObjects: 1 })];

  it("sorts by size (largest first) and pre-selects NOTHING, with the explanatory hint", () => {
    wrap(<BucketTable buckets={buckets} canEdit saving={false} onSave={() => undefined} />);
    const names = screen.getAllByText(/^(db-declareall|uploads|tiny)$/).map((e) => e.textContent);
    expect(names).toEqual(["uploads", "db-declareall", "tiny"]);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    expect(boxes.every((x) => !x.checked)).toBe(true);
    expect(screen.getByText(/Nothing is selected/)).toBeTruthy();
    expect(screen.getByText("Destination already has 12 object(s)")).toBeTruthy();
    expect(screen.getByText(/90,000 Objects|90,000/)).toBeTruthy();
  });

  it("saves exactly the chosen buckets with rename and parsed exclude globs", () => {
    const onSave = vi.fn();
    wrap(<BucketTable buckets={buckets} canEdit saving={false} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText("Select uploads"));
    fireEvent.change(screen.getByLabelText("Destination name"), { target: { value: "uploads-new" } });
    fireEvent.change(screen.getByLabelText("Exclude (comma separated globs)"), { target: { value: "tmp/*, *.log" } });
    fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
    const rows = onSave.mock.calls[0][0] as Array<{ srcBucket: string; dstBucket: string; selected: boolean; exclude: string[] }>;
    expect(rows.filter((r) => r.selected)).toEqual([{ srcBucket: "uploads", dstBucket: "uploads-new", selected: true, exclude: ["tmp/*", "*.log"] }]);
    expect(rows.find((r) => r.srcBucket === "db-declareall")!.selected).toBe(false);
  });

  it("a viewer cannot edit; a running bucket's checkbox is locked; unknown sizes say so", () => {
    wrap(<BucketTable buckets={[b({ srcBucket: "x-bucket", status: "SEEDING", selected: true })]} canEdit={false} saving={false} onSave={() => undefined} />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save selection" })).toBeNull();
    expect(screen.getByText("size unknown")).toBeTruthy();
  });

  it("is mobile friendly: the per-bucket editor wraps via an auto-fit grid (no fixed columns)", () => {
    const { container } = wrap(<BucketTable buckets={[b({ srcBucket: "x-bucket", selected: true })]} canEdit saving={false} onSave={() => undefined} />);
    const grids = Array.from(container.querySelectorAll<HTMLElement>("div")).map((d) => d.style.gridTemplateColumns).filter(Boolean);
    expect(grids.some((g) => g.includes("auto-fit"))).toBe(true);
  });
});

describe("FreezeAckDialog", () => {
  it("the start button stays disabled until the 'writes are stopped' box is ticked; --remove is a SEPARATE, off-by-default box", () => {
    const onConfirm = vi.fn();
    wrap(<FreezeAckDialog busy={false} onCancel={() => undefined} onConfirm={onConfirm} />);
    const start = screen.getByRole("button", { name: "Start final pass" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    const remove = screen.getByLabelText(/Also delete destination objects/) as HTMLInputElement;
    expect(remove.checked).toBe(false);
    fireEvent.click(remove); // ticking --remove alone does NOT enable start
    expect(start.disabled).toBe(true);
    expect(screen.getByText("This deletes objects on the destination. It is off by default.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I stopped the writers/));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(onConfirm).toHaveBeenCalledWith({ removeExtraneous: true });
  });
  it("confirm without --remove passes removeExtraneous false", () => {
    const onConfirm = vi.fn();
    wrap(<FreezeAckDialog busy={false} onCancel={() => undefined} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByLabelText(/I stopped the writers/));
    fireEvent.click(screen.getByRole("button", { name: "Start final pass" }));
    expect(onConfirm).toHaveBeenCalledWith({ removeExtraneous: false });
  });
});

describe("PhasePanel", () => {
  const h = (over: Partial<PhaseHandlers> = {}): PhaseHandlers => ({ onSeed: vi.fn(), onFinal: vi.fn(), onVerify: vi.fn(), onCancel: vi.fn(), mergeAck: false, onMergeAck: vi.fn(), needsMergeAck: false, busy: false, ...over });

  it("shows per-bucket progress bars, translated status, the CLASSIFIED error and the verify counts", () => {
    const mig = m({ status: "SEEDING", phase: "seed" }, [
      b({ idx: 0, srcBucket: "uploads", selected: true, status: "SEEDING", srcBytes: 1000, doneBytes: 250 }),
      b({ idx: 1, srcBucket: "docs", selected: true, status: "FAILED", lastError: "access-denied" }),
      b({ idx: 2, srcBucket: "media", selected: true, status: "DIFFERS", diffMissing: 2, diffDiffer: 1, diffExtra: 4 }),
    ]);
    wrap(<PhasePanel m={mig} h={h()} />);
    const bar = screen.getByRole("progressbar", { name: "uploads" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("Access denied by one of the endpoints.")).toBeTruthy();
    expect(screen.getByText(/Missing on the destination: 2 - Different: 1 - Extra on the destination: 4/)).toBeTruthy();
    expect(screen.getByText("Compares keys and sizes (mc diff). It is not a content-hash check.")).toBeTruthy();
    expect(screen.queryByText(/checksum/i)).toBeNull(); // never claims a checksum verification
  });

  it("buttons follow the state machine: seeding => only Cancel; preflighted + selection => Start seed", () => {
    const live = m({ status: "SEEDING" }, [b({ selected: true, status: "SEEDING" })]);
    const { unmount } = wrap(<PhasePanel m={live} h={h()} />);
    expect((screen.getByRole("button", { name: "Start seed copy" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    unmount();
    const onSeed = vi.fn();
    wrap(<PhasePanel m={m({}, [b({ selected: true })])} h={h({ onSeed })} />);
    const seed = screen.getByRole("button", { name: "Start seed copy" });
    expect((seed as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(seed);
    expect(onSeed).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("a non-empty destination needs the merge acknowledgement before seed is enabled", () => {
    const onMergeAck = vi.fn();
    wrap(<PhasePanel m={m({}, [b({ selected: true, dstObjects: 9 })])} h={h({ needsMergeAck: true, onMergeAck })} />);
    expect((screen.getByRole("button", { name: "Start seed copy" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/copy into them anyway/));
    expect(onMergeAck).toHaveBeenCalledWith(true);
  });
});

describe("ConfigCarry", () => {
  it("lists what was exported (presence only) and applies on click; hidden when nothing is exportable", () => {
    const onCarry = vi.fn();
    const { unmount } = wrap(<ConfigCarry canCarry busy={false} onCarry={onCarry} buckets={[b({ srcBucket: "uploads", selected: true, configSummary: { policy: true, lifecycle: false, tags: true }, configStatus: "EXPORTED" })]} />);
    expect(screen.getByText(/policy, tags/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply to destination" }));
    expect(onCarry).toHaveBeenCalled();
    unmount();
    wrap(<ConfigCarry canCarry busy={false} onCarry={onCarry} buckets={[b({ selected: true, configSummary: null })]} />);
    expect(screen.queryByRole("button", { name: "Apply to destination" })).toBeNull();
    expect(screen.getByText("nothing to carry")).toBeTruthy();
  });
});

describe("SourceDestinationForm", () => {
  beforeEach(() => {
    vi.spyOn(api, "listServers").mockResolvedValue([{ id: "srv1", name: "Server A", teamId: "t1", status: "ONLINE", clusterId: null, tags: [] }] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("submits only when every field is present and both endpoints look like http(s) origins; secrets are password fields", async () => {
    const onSubmit = vi.fn();
    wrap(<SourceDestinationForm busy={false} onSubmit={onSubmit} />);
    await screen.findByRole("option", { name: "Server A" });
    const submit = screen.getByRole("button", { name: "Create and check" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const form = submit.closest("form")!;
    const pw = Array.from(form.querySelectorAll<HTMLInputElement>("input[type=password]"));
    expect(pw).toHaveLength(2); // both secret keys are masked
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "minio move" } });
    const [srcEp, dstEp] = screen.getAllByLabelText("Endpoint");
    fireEvent.change(srcEp, { target: { value: "https://src.example.com:9000" } });
    const [srcAk, dstAk] = screen.getAllByLabelText("Access key");
    fireEvent.change(srcAk, { target: { value: "AK1" } });
    fireEvent.change(dstAk, { target: { value: "AK2" } });
    const [srcSk, dstSk] = screen.getAllByLabelText("Secret key");
    fireEvent.change(srcSk, { target: { value: "SK1" } });
    fireEvent.change(dstSk, { target: { value: "SK2" } });
    expect(submit.disabled).toBe(false); // the destination defaults to the same-host MinIO
    fireEvent.change(dstEp, { target: { value: "https://user:pw@evil.example.com/path" } });
    expect(submit.disabled).toBe(true); // userinfo / path refused client-side too
    fireEvent.change(dstEp, { target: { value: "http://host.docker.internal:9100" } });
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith({
      name: "minio move", targetServerId: "srv1", preserve: true,
      source: { endpoint: "https://src.example.com:9000", accessKey: "AK1", secretKey: "SK1" },
      destination: { endpoint: "http://host.docker.internal:9100", accessKey: "AK2", secretKey: "SK2" },
    });
    expect(within(form).getByText(/Use a read-only key/)).toBeTruthy();
  });
});
