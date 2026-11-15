import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api, ApiError } from "../../../lib/api";
import type { PublicUser, SecretsKeyInfo, SecretsKeyStatus } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
const toastFn = vi.hoisted(() => vi.fn());
vi.mock("../../../components/toast", () => ({ useToast: () => toastFn }));

import { SecretsKeyCard } from "./secrets-key-card";

const keyInfo = (over: Partial<SecretsKeyInfo> = {}): SecretsKeyInfo => ({
  id: "3bb17d6ca64cc6f9",
  source: "env",
  role: "active",
  createdAt: null,
  activatedAt: null,
  demotedAt: null,
  retiredAt: null,
  referenced: 4,
  retirable: false,
  retireBlockedReason: null,
  ...over,
});
const status = (over: Partial<SecretsKeyStatus> = {}): SecretsKeyStatus => ({
  currentKeyId: "3bb17d6ca64cc6f9",
  previousKeyIds: [],
  epoch: 0,
  degraded: null,
  byKey: { "3bb17d6ca64cc6f9": 4 },
  downgradeSafe: true,
  keys: [keyInfo()],
  models: [{ model: "application", current: 4, stale: 0, unreadable: 0 }],
  totals: { current: 4, stale: 0, unreadable: 0 },
  hmacRowsOnOldKeys: [{ model: "twoFactorRecoveryCode", column: "codeHash", count: 0 }],
  previousKeyRemovable: true,
  running: false,
  lastRun: null,
  ...over,
});

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <SecretsKeyCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("SecretsKeyCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    toastFn.mockClear();
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(status());
    vi.spyOn(api, "reencryptSecrets").mockResolvedValue({ startedAt: "2026-11-14T00:00:00Z" });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches", () => {
    wrap();
    expect(screen.queryByText("Secrets encryption key")).toBeNull();
    expect(api.getSecretsKeyStatus).not.toHaveBeenCalled();
  });

  it("owner, no rotation in progress: shows the current key id, 'none' for previous keys, and a disabled re-encrypt button", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(await screen.findByText("3bb17d6ca64cc6f9")).toBeTruthy();
    expect(screen.getByText("Secrets encryption key")).toBeTruthy();
    expect(screen.getByText("none — no rotation in progress")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Re-encrypt now" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/two-factor recovery codes/)).toBeNull();
  });

  it("rotation pending: lists previous keys, stale/unreadable counts per table, recovery-code warning, and re-encrypts on click", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(
      status({
        previousKeyIds: ["a0595c9b413ca318"],
        models: [
          { model: "application", current: 1, stale: 2, unreadable: 1 },
          { model: "registry", current: 3, stale: 0, unreadable: 0 },
        ],
        totals: { current: 4, stale: 2, unreadable: 1 },
        hmacRowsOnOldKeys: [{ model: "twoFactorRecoveryCode", column: "codeHash", count: 7 }],
        previousKeyRemovable: false,
      }),
    );
    wrap();
    expect(await screen.findByText("a0595c9b413ca318")).toBeTruthy();
    expect(screen.getByText("4 secrets under the current key · 2 still on an old key · 1 unreadable")).toBeTruthy();
    expect(screen.getByText(/Unreadable secrets were written with a key/)).toBeTruthy();
    expect(screen.getByText(/7 two-factor recovery codes/)).toBeTruthy();
    expect(screen.getByText(/Keep SECRETS_ENCRYPTION_KEY_PREVIOUS set/)).toBeTruthy();
    // per-table breakdown only lists tables with something left to do
    fireEvent.click(screen.getByText("By table"));
    expect(screen.getByText(/application: 1 secrets under the current key/)).toBeTruthy();
    expect(screen.queryByText(/registry:/)).toBeNull();
    const btn = screen.getByRole("button", { name: "Re-encrypt now" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(api.reencryptSecrets).toHaveBeenCalledTimes(1));
  });

  it("all current after a rotation: says the previous key can be removed and shows the last run", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(
      status({
        previousKeyIds: ["a0595c9b413ca318"],
        previousKeyRemovable: true,
        lastRun: { startedAt: "2026-11-14T10:00:00Z", finishedAt: "2026-11-14T10:00:05Z", actor: "u1", rewritten: 12, alreadyCurrent: 3, unreadable: 0, skipped: 0, errors: 0, unreadableRefs: [], error: null },
      }),
    );
    wrap();
    expect(await screen.findByText(/you can remove SECRETS_ENCRYPTION_KEY_PREVIOUS/)).toBeTruthy();
    expect(screen.getByText(/12 rewritten · 3 already current/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Re-encrypt now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // ---- keyring (rotate without a restart) ----
  const RING_ID = "aaaaaaaaaaaaaaaa";
  const OLD_RING = "bbbbbbbbbbbbbbbb";
  const ringStatus = (over: Partial<SecretsKeyStatus> = {}, oldKey: Partial<SecretsKeyInfo> = {}) =>
    status({
      currentKeyId: RING_ID,
      previousKeyIds: [OLD_RING, "3bb17d6ca64cc6f9"],
      downgradeSafe: false,
      byKey: { [RING_ID]: 3 },
      keys: [
        keyInfo({ id: RING_ID, source: "ring", role: "active", referenced: 3 }),
        keyInfo({ id: OLD_RING, source: "ring", role: "decrypt-only", referenced: 0, retirable: true, ...oldKey }),
        keyInfo({ id: "3bb17d6ca64cc6f9", source: "env", role: "root", referenced: 0 }),
      ],
      ...over,
    });

  it("renders the keys list (collapsed by default): short id with the full id in the title, role, source and reference count", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(ringStatus());
    wrap();
    await screen.findByText("Keys");
    const details = screen.getByText("Keys").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const rows = screen.getAllByTestId("secrets-key-row");
    expect(rows).toHaveLength(3);
    const first = within(rows[0]);
    expect(first.getByText("aaaaaaaa").getAttribute("title")).toBe(RING_ID);
    expect(first.getByText("Active")).toBeTruthy();
    expect(first.getByText("Key ring")).toBeTruthy();
    expect(first.getByText("3 secrets use this key")).toBeTruthy();
    expect(within(rows[2]).getByText("Root (.env)")).toBeTruthy();
    // env keys never get actions; the active ring key neither
    expect(within(rows[0]).queryByRole("button")).toBeNull();
    expect(within(rows[2]).queryByRole("button")).toBeNull();
  });

  it("Retire is enabled only for a retirable decrypt-only key; otherwise disabled with the reason; Restore for a retired one", async () => {
    h.user = { isInstanceOwner: true };
    const retire = vi.spyOn(api, "retireSecretsKey").mockResolvedValue({ keyId: OLD_RING, state: "RETIRED" });
    const restore = vi.spyOn(api, "restoreSecretsKey").mockResolvedValue({ keyId: "cccccccccccccccc", state: "DECRYPT_ONLY" });
    const get = vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(
      ringStatus({}, {}),
    );
    wrap();
    await screen.findByText("Keys");
    const btn = screen.getByRole("button", { name: "Retire" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(retire).toHaveBeenCalledWith(OLD_RING));
    cleanup();

    for (const [reason, text] of [
      ["referenced", "Still used by stored secrets"],
      ["grace", "Replaced moments ago, wait a minute"],
      ["running", "Re-encryption is running"],
      ["degraded", "Key ring is degraded"],
    ] as const) {
      qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      get.mockResolvedValue(ringStatus({}, { retirable: false, retireBlockedReason: reason, referenced: reason === "referenced" ? 2 : 0 }));
      const { unmount } = wrap();
      await screen.findByText(text);
      expect((screen.getByRole("button", { name: "Retire" }) as HTMLButtonElement).disabled).toBe(true);
      unmount();
    }

    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    get.mockResolvedValue(
      ringStatus({ keys: [keyInfo({ id: RING_ID, source: "ring", role: "active" }), keyInfo({ id: "cccccccccccccccc", source: "ring", role: "retired", referenced: 0 }), keyInfo({ id: "3bb17d6ca64cc6f9", source: "env", role: "root" })] }),
    );
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("cccccccccccccccc"));
  });

  it("Rotate key opens a confirm with 'Re-encrypt everything now' on by default and sends the CAS id", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(status());
    const rotate = vi.spyOn(api, "rotateSecretsKey").mockResolvedValue({ keyId: RING_ID, epoch: 1, reencryptStarted: true });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByLabelText("Re-encrypt everything now") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(rotate).toHaveBeenCalledWith({ expectedCurrentKeyId: "3bb17d6ca64cc6f9", target: "new-key", reencrypt: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toastFn).toHaveBeenCalledWith("Key rotated", "success");
  });

  it("unchecking re-encrypt sends reencrypt:false", async () => {
    h.user = { isInstanceOwner: true };
    const rotate = vi.spyOn(api, "rotateSecretsKey").mockResolvedValue({ keyId: RING_ID, epoch: 1, reencryptStarted: false });
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Re-encrypt everything now"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(rotate).toHaveBeenCalledWith(expect.objectContaining({ reencrypt: false })));
  });

  it("a 409 stale_current refetches the status and shows the stale message; other codes map to secretsKeyErr; unknown falls back", async () => {
    h.user = { isInstanceOwner: true };
    const get = vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(status());
    const rotate = vi.spyOn(api, "rotateSecretsKey").mockRejectedValueOnce(new ApiError(409, "stale", "stale_current"));
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(toastFn).toHaveBeenCalledWith(expect.stringContaining("The active key changed while this page was open"), "error"));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2)); // refetched
    expect(screen.queryByRole("dialog")).toBeNull();

    rotate.mockRejectedValueOnce(new ApiError(409, "busy", "rotation_running"));
    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(toastFn).toHaveBeenCalledWith("A re-encryption is running. Wait for it to finish.", "error"));

    rotate.mockRejectedValueOnce(new ApiError(500, "", undefined));
    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Rotate key" }));
    await waitFor(() => expect(toastFn).toHaveBeenCalledWith("Could not rotate the key", "error"));
  });

  it("a degraded ring shows the red banner and disables Rotate and Back-to-env", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(ringStatus({ degraded: "key aaaaaaaaaaaaaaaa cannot be unwrapped with the configured root key(s)" }));
    wrap();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/The key ring is degraded: key aaaaaaaaaaaaaaaa cannot be unwrapped/);
    expect((screen.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Back to .env key" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Rotate is disabled while a re-encryption runs", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(status({ running: true }));
    wrap();
    await screen.findByText("3bb17d6ca64cc6f9");
    expect((screen.getByRole("button", { name: "Rotate key" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("downgrade note + 'Back to .env key' appear only when a ring key is active and secrets still depend on it; confirm sends env-root", async () => {
    h.user = { isInstanceOwner: true };
    const get = vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(ringStatus());
    const rotate = vi.spyOn(api, "rotateSecretsKey").mockResolvedValue({ keyId: "3bb17d6ca64cc6f9", epoch: 2, reencryptStarted: true });
    wrap();
    expect(await screen.findByText(/Before rolling back to an older Tugra release/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to .env key" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Make the SECRETS_ENCRYPTION_KEY from your .env the encryption key again/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to .env key" }));
    await waitFor(() => expect(rotate).toHaveBeenCalledWith({ expectedCurrentKeyId: RING_ID, target: "env-root", reencrypt: true }));
    cleanup();

    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    get.mockResolvedValue(ringStatus({ downgradeSafe: true }));
    wrap();
    await screen.findByText("Keys");
    expect(screen.queryByText(/Before rolling back/)).toBeNull();
    cleanup();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    get.mockResolvedValue(status()); // env-only: no ring key at all
    wrap();
    await screen.findByText("3bb17d6ca64cc6f9");
    expect(screen.queryByRole("button", { name: "Back to .env key" })).toBeNull();
  });

  it("the old env-restart removable/pending text is shown only when no ring key exists", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(ringStatus({ previousKeyRemovable: true }));
    wrap();
    await screen.findByText("Keys");
    expect(screen.queryByText(/you can remove SECRETS_ENCRYPTION_KEY_PREVIOUS/)).toBeNull();
    expect(screen.queryByText(/Keep SECRETS_ENCRYPTION_KEY_PREVIOUS set/)).toBeNull();
  });

  it("badge: a retirable ring key reads 'Rotation complete'; pending stays 'Rotation in progress'; plain is 'No rotation'", async () => {
    h.user = { isInstanceOwner: true };
    const get = vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(ringStatus());
    const { unmount } = wrap();
    expect(await screen.findByText("Rotation complete")).toBeTruthy();
    unmount();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    get.mockResolvedValue(ringStatus({ totals: { current: 1, stale: 2, unreadable: 0 } }));
    const b = wrap();
    expect(await screen.findByText("Rotation in progress")).toBeTruthy();
    b.unmount();
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    get.mockResolvedValue(status());
    wrap();
    expect(await screen.findByText("No rotation")).toBeTruthy();
  });

  it("never renders key material: only 8-char short ids, the full id in a title, no wraps", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getSecretsKeyStatus").mockResolvedValue(ringStatus());
    const { container } = wrap();
    await screen.findByText("Keys");
    expect(container.textContent).not.toMatch(/tk1\./);
  });
});
