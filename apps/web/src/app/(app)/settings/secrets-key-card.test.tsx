import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { PublicUser, SecretsKeyStatus } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../../../components/toast", () => ({ useToast: () => vi.fn() }));

import { SecretsKeyCard } from "./secrets-key-card";

const status = (over: Partial<SecretsKeyStatus> = {}): SecretsKeyStatus => ({
  currentKeyId: "3bb17d6ca64cc6f9",
  previousKeyIds: [],
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
});
