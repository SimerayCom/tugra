import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";

// Render as the instance owner so the privileged toggle is present.
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: { isInstanceOwner: true } }) }));

import { DockerOptionsCard } from "./docker-options-card";
import { api } from "../lib/api";

afterEach(cleanup);

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("DockerOptionsCard", () => {
  it("labels the flags field and gates Save until it changes, then PUTs", async () => {
    const set = vi.spyOn(api, "setAppDockerOptions").mockResolvedValue({ ok: true });
    wrap(<DockerOptionsCard id="a1" dockerOptions={null} allowPrivileged={false} />);
    expect(screen.getByLabelText("Docker run flags")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Docker run flags"), { target: { value: "--cap-add=NET_ADMIN" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", "--cap-add=NET_ADMIN"));
  });

  it("confirms before enabling privileged host options", async () => {
    const toggle = vi.spyOn(api, "setAppAllowPrivilegedDockerOptions").mockResolvedValue({ ok: true });
    wrap(<DockerOptionsCard id="a1" dockerOptions={null} allowPrivileged={false} />);
    fireEvent.click(screen.getByLabelText(/Allow privileged/));
    expect(toggle).not.toHaveBeenCalled(); // not until confirmed
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith("a1", true));
  });
});
