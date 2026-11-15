import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import type { Application, ImageUpdate } from "../../../../lib/types";
import { ImageUpdateBadge, ImageUpdateCard } from "./image-update-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const iu = (over: Partial<ImageUpdate> = {}): ImageUpdate => ({
  enabled: true,
  state: "up_to_date",
  updateAvailable: false,
  checkedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  changedAt: null,
  error: null,
  upstreamDigest: "sha256:" + "b".repeat(64),
  deployedDigest: "sha256:" + "a".repeat(64),
  ...over,
});
const app = (imageUpdate: ImageUpdate | null): Application => ({ id: "a1", name: "web", imageUpdate }) as unknown as Application;

function show(a: Application, perms: { canWrite?: boolean; canDeploy?: boolean } = {}, onRedeploy = vi.fn(), qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })) {
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ImageUpdateCard app={a} canWrite={perms.canWrite ?? true} canDeploy={perms.canDeploy ?? true} onRedeploy={onRedeploy} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { qc, onRedeploy };
}

describe("ImageUpdateCard — states", () => {
  const cases: [Partial<ImageUpdate>, string][] = [
    [{ state: "up_to_date" }, "Up to date"],
    [{ state: "update_available", updateAvailable: true, changedAt: new Date().toISOString() }, "A newer image is available"],
    [{ state: "pending", checkedAt: null }, "Not checked yet"],
    [{ state: "no_baseline", checkedAt: null }, "Redeploy once so Tugra can record this image's digest"],
    [{ state: "pinned" }, "Pinned to a digest — nothing to update"],
    [{ state: "unsupported" }, "This image reference can't be checked for updates"],
    [{ state: "disabled", enabled: false }, "Update checks are off"],
    [{ state: "error", error: "auth" }, "Last check failed: the registry rejected the credentials"],
  ];
  for (const [over, text] of cases) {
    it(`renders "${text}"`, () => {
      show(app(iu(over)));
      expect(screen.getByText(text)).toBeTruthy();
    });
  }

  it("renders nothing when the app has no image-update verdict", () => {
    show(app(null));
    expect(screen.queryByText("Image updates")).toBeNull();
  });

  it("shows when it was checked, and since when a newer image has been seen", () => {
    show(app(iu({ state: "update_available", updateAvailable: true, changedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })));
    expect(screen.getByText("Checked 3m ago")).toBeTruthy();
    expect(screen.getByText("newer image seen 2h ago")).toBeTruthy();
  });

  it("gives the right hint per error code (only the ones with advice)", () => {
    show(app(iu({ state: "error", error: "unsupported" })));
    expect(screen.getByText(/Update the agent on this server/)).toBeTruthy();
    cleanup();
    show(app(iu({ state: "error", error: "failed" })));
    expect(screen.getByText(/runs from the agent container/)).toBeTruthy();
    cleanup();
    show(app(iu({ state: "error", error: "notfound" })));
    expect(screen.getByText("Last check failed: image or tag not found")).toBeTruthy();
    expect(screen.queryByText(/runs from the agent container/)).toBeNull();
  });
});

describe("ImageUpdateCard — permissions", () => {
  it("shows short digests only to a writer (the hub nulls them for readers)", () => {
    show(app(iu()));
    expect(screen.getByText("sha256:aaaaaaaaaa…")).toBeTruthy();
    expect(screen.getByText("sha256:bbbbbbbbbb…")).toBeTruthy();
    cleanup();
    show(app(iu({ upstreamDigest: null, deployedDigest: null })), { canWrite: false, canDeploy: false });
    expect(screen.queryByText("Deployed")).toBeNull();
    expect(screen.queryByText(/sha256:/)).toBeNull();
  });

  it("a read-only member gets the verdict but no buttons and no toggle", () => {
    show(app(iu({ state: "update_available", updateAvailable: true })), { canWrite: false, canDeploy: false });
    expect(screen.getByText("A newer image is available")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("a deploy-only member can check and redeploy but not flip the toggle", () => {
    show(app(iu({ state: "update_available", updateAvailable: true })), { canWrite: false, canDeploy: true });
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pull/ })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("a config-only member sees the toggle but no deploy actions", () => {
    show(app(iu({ state: "update_available", updateAvailable: true })), { canWrite: true, canDeploy: false });
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("hides Pull & redeploy unless an update is available, and Check now for disabled/pinned/no-baseline", () => {
    show(app(iu({ state: "up_to_date" })));
    expect(screen.getByRole("button", { name: "Check now" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pull/ })).toBeNull();
    for (const state of ["disabled", "pinned", "unsupported", "no_baseline"] as const) {
      cleanup();
      show(app(iu({ state })));
      expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    }
  });

  it("no opt-out toggle for a digest-pinned image", () => {
    show(app(iu({ state: "pinned" })));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("ImageUpdateCard — actions", () => {
  it("Check now calls the API and merges the fresh verdict into the app's query cache", async () => {
    const fresh = iu({ state: "update_available", updateAvailable: true });
    const spy = vi.spyOn(api, "checkImageUpdate").mockResolvedValue({ imageUpdate: fresh });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData(["app", "a1"], app(iu()));
    show(app(iu()), {}, vi.fn(), qc);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect((qc.getQueryData(["app", "a1"]) as Application).imageUpdate?.state).toBe("update_available"));
  });

  it("Pull & redeploy calls onRedeploy", () => {
    const { onRedeploy } = show(app(iu({ state: "update_available", updateAvailable: true })));
    fireEvent.click(screen.getByRole("button", { name: /Pull/ }));
    expect(onRedeploy).toHaveBeenCalledTimes(1);
  });

  it("the toggle calls setImageUpdateCheck with the new value", async () => {
    const spy = vi.spyOn(api, "setImageUpdateCheck").mockResolvedValue({ ok: true });
    show(app(iu()));
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("a1", false));
  });

  it("a failed check surfaces the API message as a toast and leaves the card intact", async () => {
    const spy = vi.spyOn(api, "checkImageUpdate").mockRejectedValue(new Error("server is offline"));
    const bus = await import("../../../../lib/toast-bus");
    const emit = vi.spyOn(bus, "emitToast");
    show(app(iu()));
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await waitFor(() => expect(emit).toHaveBeenCalledWith("server is offline", "error", undefined));
    expect(screen.getByText("Up to date")).toBeTruthy();
  });
});

describe("ImageUpdateBadge (header + list row chip)", () => {
  const badge = (a: { imageUpdate?: ImageUpdate | null }) =>
    render(<I18nProvider><ImageUpdateBadge app={a} /></I18nProvider>);
  it("shows 'Update available' only for update_available", () => {
    badge({ imageUpdate: iu({ state: "update_available", updateAvailable: true }) });
    expect(screen.getByText("Update available")).toBeTruthy();
  });
  it("renders nothing for every other state and for a missing verdict", () => {
    for (const a of [{ imageUpdate: iu({ state: "up_to_date" }) }, { imageUpdate: iu({ state: "error", error: "auth" }) }, { imageUpdate: iu({ state: "pending" }) }, { imageUpdate: null }, {}]) {
      const { container } = badge(a);
      expect(container.textContent).toBe("");
      cleanup();
    }
  });
});
