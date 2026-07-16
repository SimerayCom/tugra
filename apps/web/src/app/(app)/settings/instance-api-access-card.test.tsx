import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import type { PublicUser } from "../../../lib/types";

const h = vi.hoisted(() => ({ user: { isInstanceOwner: false } as Partial<PublicUser> }));
vi.mock("../../../lib/auth", () => ({ useAuth: () => ({ user: h.user }) }));

import { InstanceApiAccessCard } from "./instance-api-access-card";

let qc: QueryClient;
const wrap = () =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <InstanceApiAccessCard />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("InstanceApiAccessCard", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    h.user = { isInstanceOwner: false };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ apiEnabled: true, apiAllowedIps: ["10.0.0.0/8"] });
    vi.spyOn(api, "updateInstanceSettings").mockResolvedValue({ apiEnabled: true, apiAllowedIps: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("renders nothing for a non-owner and never fetches settings", () => {
    wrap();
    expect(screen.queryByText("API access")).toBeNull();
    expect(api.getInstanceSettings).not.toHaveBeenCalled();
  });

  it("shows the panel for the owner and seeds it from the server", async () => {
    h.user = { isInstanceOwner: true };
    wrap();
    expect(await screen.findByText("API access")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Allowed IP addresses") as HTMLTextAreaElement).value).toBe("10.0.0.0/8"));
  });

  it("saves the toggle + parsed allowlist (blank lines dropped)", async () => {
    h.user = { isInstanceOwner: true };
    vi.spyOn(api, "getInstanceSettings").mockResolvedValue({ apiEnabled: true, apiAllowedIps: ["9.9.9.9"] });
    wrap();
    const ta = (await screen.findByLabelText("Allowed IP addresses")) as HTMLTextAreaElement;
    // Wait for the server seed to apply before editing, so the effect doesn't clobber our input.
    await waitFor(() => expect(ta.value).toBe("9.9.9.9"));
    fireEvent.change(ta, { target: { value: "1.2.3.4\n\n  \n5.6.7.8/24" } });
    fireEvent.click(screen.getByRole("checkbox")); // turn API access OFF
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateInstanceSettings).toHaveBeenCalledWith({ apiEnabled: false, apiAllowedIps: ["1.2.3.4", "5.6.7.8/24"] }),
    );
  });
});
