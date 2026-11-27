import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { AppIconCard } from "./app-detail-misc-cards";
import type { Application } from "../../../../lib/types";

vi.mock("../../../../components/toast", () => ({ useToast: () => vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const app = { id: "app1", name: "web", source: "IMAGE", image: "nginx:alpine", domain: null, templateSlug: null, templateLogo: null, iconUpdatedAt: null, iconKey: null, canWrite: true } as unknown as Application;
let qc: QueryClient;
beforeEach(() => { qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); });
const show = (a: Application, onChanged = vi.fn()) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <AppIconCard app={a} onChanged={onChanged} />
      </I18nProvider>
    </QueryClientProvider>,
  );

describe("AppIconCard picker", () => {
  it("saves the picked icon key and refreshes the app", async () => {
    const set = vi.spyOn(api, "setAppIconKey").mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    show(app, onChanged);
    fireEvent.click(screen.getByRole("button", { name: "Choose from the icon set" }));
    fireEvent.click(screen.getByRole("button", { name: "Use grafana" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("app1", "grafana"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("clears the pick through Automatic", async () => {
    const set = vi.spyOn(api, "setAppIconKey").mockResolvedValue({ ok: true });
    show({ ...app, iconKey: "grafana" } as Application);
    fireEvent.click(screen.getByRole("button", { name: "Choose from the icon set" }));
    fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("app1", null));
  });

  it("previews the picked icon", () => {
    const { container } = show({ ...app, iconKey: "grafana" } as Application);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/icons/grafana.svg");
  });
});
