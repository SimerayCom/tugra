import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { NodeLabelsEditor } from "./node-labels-editor";
import { api } from "../lib/api";

afterEach(cleanup);

let qc: QueryClient;
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );

describe("NodeLabelsEditor", () => {
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders existing label chips", () => {
    wrap(<NodeLabelsEditor clusterId="c1" nodeId="n1" labels={{ zone: "east" }} />);
    expect(screen.getByText("zone=east")).toBeTruthy();
  });

  it("removing a chip calls setNodeLabels with remove", async () => {
    const spy = vi.spyOn(api, "setNodeLabels").mockResolvedValue({} as never);
    wrap(<NodeLabelsEditor clusterId="c1" nodeId="n1" labels={{ zone: "east" }} />);
    fireEvent.click(screen.getByLabelText("Remove label"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("c1", "n1", { add: {}, remove: ["zone"] }));
  });

  it("adding a label calls setNodeLabels with add and clears the inputs", async () => {
    const spy = vi.spyOn(api, "setNodeLabels").mockResolvedValue({} as never);
    wrap(<NodeLabelsEditor clusterId="c1" nodeId="n1" labels={{}} />);
    fireEvent.change(screen.getByPlaceholderText("key"), { target: { value: "tier" } });
    fireEvent.change(screen.getByPlaceholderText("value"), { target: { value: "db" } });
    fireEvent.click(screen.getByText("Add label"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("c1", "n1", { add: { tier: "db" }, remove: [] }));
    await waitFor(() => expect((screen.getByPlaceholderText("key") as HTMLInputElement).value).toBe(""));
  });
});
