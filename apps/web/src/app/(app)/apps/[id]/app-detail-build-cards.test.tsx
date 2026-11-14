import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api } from "../../../../lib/api";
import { BuildSecretsCard, looksSensitiveKey } from "./app-detail-build-cards";

afterEach(cleanup);
let qc: QueryClient;
const wrap = (ui: React.ReactElement) =>
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider>{ui}</I18nProvider>
    </QueryClientProvider>,
  );
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => vi.restoreAllMocks());

describe("looksSensitiveKey", () => {
  it("flags credential-looking build-arg keys and leaves ordinary ones alone", () => {
    for (const k of ["NPM_TOKEN", "GITHUB_TOKEN", "DB_PASSWORD", "API_KEY", "api-key", "NEXTAUTH_SECRET", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "PRIVATE_KEY"]) expect(looksSensitiveKey(k)).toBe(true);
    for (const k of ["NODE_ENV", "NEXTAUTH_URL", "AUTHOR", "PRIVATE_REGISTRY_URL", "KEYCLOAK_URL", "API_URL"]) expect(looksSensitiveKey(k)).toBe(false);
  });
});

describe("BuildSecretsCard", () => {
  it("explains and offers nothing for a non-Dockerfile build pack (and never fetches)", () => {
    const get = vi.spyOn(api, "getAppBuildSecrets");
    wrap(<BuildSecretsCard id="a1" source="GIT" buildType="NIXPACKS" />);
    expect(screen.getByText(/Only a Dockerfile build can mount secrets/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("masks stored values until revealed, keeps Save disabled until the stored map has loaded, and sends untouched stored values back verbatim", async () => {
    vi.spyOn(api, "getAppBuildSecrets").mockResolvedValue({ NPM_TOKEN: "npm_xyz" });
    const set = vi.spyOn(api, "setAppBuildSecrets").mockResolvedValue({ ok: true });
    wrap(<BuildSecretsCard id="a1" source="GIT" buildType="DOCKERFILE" />);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true); // not loaded yet
    await waitFor(() => expect(screen.getByDisplayValue("NPM_TOKEN")).toBeTruthy());
    const value = screen.getByPlaceholderText("Set (hidden)") as HTMLInputElement;
    expect(value.value).toBe(""); // masked: the plaintext is not in the DOM
    fireEvent.click(screen.getByRole("button", { name: "Reveal secret" }));
    expect(screen.getByDisplayValue("npm_xyz")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide secret" }));
    expect(screen.queryByDisplayValue("npm_xyz")).toBeNull();
    // add a second secret, save → both are sent, the stored one verbatim
    fireEvent.click(screen.getByRole("button", { name: "+ Add secret" }));
    const keys = screen.getAllByLabelText("Key");
    fireEvent.change(keys[1], { target: { value: "GH_TOKEN" } });
    const values = screen.getAllByLabelText("Value");
    fireEvent.change(values[1], { target: { value: "gh_abc" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { NPM_TOKEN: "npm_xyz", GH_TOKEN: "gh_abc" }));
  });

  it("refuses a non-identifier secret id", async () => {
    vi.spyOn(api, "getAppBuildSecrets").mockResolvedValue({});
    wrap(<BuildSecretsCard id="a1" source="GIT" buildType="DOCKERFILE" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "+ Add secret" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "+ Add secret" }));
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "bad-key" } });
    expect(screen.getByText(/Secret ids must be identifiers/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });
});
