import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { AcmeDnsCredentialPicker } from "./acme-dns-credential-picker";
import { api } from "../lib/api";

afterEach(cleanup);

const cred = (o: Record<string, unknown>) => ({ id: "c1", name: "CF main", teamId: "t1", provider: "cloudflare", cfAccountId: null, lastVerifiedAt: null, createdAt: "", canWrite: true, ...o });

function mount(props: Partial<React.ComponentProps<typeof AcmeDnsCredentialPicker>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = vi.fn();
  const onReapply = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <AcmeDnsCredentialPicker teamId="t1" value="" onChange={onChange} linkedId={null} onReapply={onReapply} {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onChange, onReapply };
}

describe("AcmeDnsCredentialPicker", () => {
  beforeEach(() => {
    vi.spyOn(api, "listDnsCredentials").mockResolvedValue([cred({}), cred({ id: "c2", name: "Other team", teamId: "t2" }), cred({ id: "c3", name: "Read only", canWrite: false })] as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("lists only the server's team credentials and reports the pick", async () => {
    const { onChange } = mount();
    await screen.findByRole("option", { name: "CF main (cloudflare)" });
    expect(screen.queryByRole("option", { name: /Other team/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Use a team DNS credential"), { target: { value: "c1" } });
    expect(onChange).toHaveBeenCalledWith("c1");
  });

  it("states that the token is copied and a rotation needs a re-apply", async () => {
    mount();
    await screen.findByRole("option", { name: "CF main (cloudflare)" });
    expect(screen.getByText(/copied to this server/)).toBeTruthy();
    expect(screen.getByText(/keeps the old token until you re-apply/)).toBeTruthy();
  });

  it("shows a coverage hint for the picked credential (unverified, read-only)", async () => {
    mount({ value: "c1" });
    await screen.findByText(/Not verified yet/);
    cleanup();
    mount({ value: "c3" });
    await screen.findByText(/read-only/);
  });

  it("re-apply is available only for the credential already in use", async () => {
    const { onReapply } = mount({ value: "c1", linkedId: "c1" });
    const btn = await screen.findByRole("button", { name: "Re-apply token" });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onReapply).toHaveBeenCalledTimes(1);
    cleanup();
    mount({ value: "c1", linkedId: null });
    expect(await screen.findByRole("button", { name: "Re-apply token" })).toBeDisabled();
  });
});
