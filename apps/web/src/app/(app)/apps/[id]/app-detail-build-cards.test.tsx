import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import { api, ApiError } from "../../../../lib/api";
import { subscribeToast, type ToastInput } from "../../../../lib/toast-bus";
import type { GitSource } from "../../../../lib/types";
import { ConfirmProvider } from "../../../../components/confirm";
import { BuildConfigCard, CredentialsCard, BuildSecretsCard, BuildSettingsCard, DeployHooksCard, DeploySettingsCard, RestartPolicyCard, SourceCard, looksSensitiveKey } from "./app-detail-build-cards";

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

describe("BuildSettingsCard — git/build behaviour toggles", () => {
  const props = {
    id: "a1",
    buildType: "DOCKERFILE" as const,
    dockerfilePath: null,
    dockerBuildTarget: null,
    baseDirectory: null,
    buildCommand: null,
    outputDir: null,
    nixpacksInstallCmd: null,
    nixpacksBuildCmd: null,
    nixpacksStartCmd: null,
    gitSubmodules: false,
    gitLfs: false,
    gitShallowClone: true,
    disableBuildCache: false,
    injectEnvAsBuildArgs: false,
    sourceCommitMode: "RUNTIME" as const,
  };
  const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

  it("renders the stored values", () => {
    wrap(<BuildSettingsCard {...props} gitSubmodules gitLfs disableBuildCache sourceCommitMode="BUILD" />);
    expect(box(/Shallow clone/).checked).toBe(true);
    expect(box(/Git submodules/).checked).toBe(true);
    expect(box(/Git LFS/).checked).toBe(true);
    expect(box(/Disable build cache/).checked).toBe(true);
    expect((screen.getByLabelText("SOURCE_COMMIT variable") as HTMLSelectElement).value).toBe("BUILD");
  });

  it("sends all six settings on save", async () => {
    const set = vi.spyOn(api, "setAppBuild").mockResolvedValue({ ok: true });
    wrap(<BuildSettingsCard {...props} />);
    fireEvent.click(box(/Shallow clone/));
    fireEvent.click(box(/Git submodules/));
    fireEvent.click(box(/Git LFS/));
    fireEvent.click(box(/Disable build cache/));
    fireEvent.click(box(/Inject environment variables/));
    fireEvent.change(screen.getByLabelText("SOURCE_COMMIT variable"), { target: { value: "OFF" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][1]).toMatchObject({
      buildType: "DOCKERFILE",
      gitShallowClone: false,
      gitSubmodules: true,
      gitLfs: true,
      disableBuildCache: true,
      injectEnvAsBuildArgs: true,
      sourceCommitMode: "OFF",
    });
  });

  it("shows the image-history warning only while env injection is checked", () => {
    wrap(<BuildSettingsCard {...props} />);
    expect(screen.queryByText(/visible in the image history/)).toBeNull();
    fireEvent.click(box(/Inject environment variables/));
    expect(screen.getByText(/visible in the image history/)).toBeTruthy();
  });

  it("disables env injection for a non-Dockerfile pack and always sends it as false", async () => {
    const set = vi.spyOn(api, "setAppBuild").mockResolvedValue({ ok: true });
    wrap(<BuildSettingsCard {...props} buildType="NIXPACKS" injectEnvAsBuildArgs />);
    const inject = box(/Inject environment variables/);
    expect(inject.disabled).toBe(true);
    expect(inject.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][1]).toMatchObject({ injectEnvAsBuildArgs: false });
  });

  it("disables 'Disable build cache' for Railpack and sends it as false even when stored on", async () => {
    const set = vi.spyOn(api, "setAppBuild").mockResolvedValue({ ok: true });
    wrap(<BuildSettingsCard {...props} buildType="RAILPACK" disableBuildCache />);
    const cache = box(/Disable build cache/);
    expect(cache.disabled).toBe(true);
    expect(cache.checked).toBe(false);
    expect(screen.getByText(/Not available for the Railpack build pack/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][1]).toMatchObject({ disableBuildCache: false });
  });

  it("explains the Build mode cost, and says it is runtime-only for Static", () => {
    const { unmount } = wrap(<BuildSettingsCard {...props} sourceCommitMode="BUILD" />);
    expect(screen.getByText(/needs ARG SOURCE_COMMIT/)).toBeTruthy();
    unmount();
    wrap(<BuildSettingsCard {...props} buildType="STATIC" sourceCommitMode="BUILD" />);
    expect(screen.getByText(/Static builds have no build arguments/)).toBeTruthy();
  });
});

describe("DeploySettingsCard — stop grace + drain", () => {
  const props = { id: "a1", deployStrategy: "ROLLING", rollbackOnFailure: true, imagesToKeep: null, postCutoverSoakSec: 0 };

  it("sends null for blank stop-grace / drain and the numbers when filled", async () => {
    const set = vi.spyOn(api, "setAppDeploySettings").mockResolvedValue({ ok: true });
    wrap(<DeploySettingsCard {...props} stopGracePeriodSec={null} drainSec={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0][1]).toMatchObject({ stopGracePeriodSec: null, drainSec: null });
    fireEvent.change(screen.getByLabelText("Stop grace period (seconds)"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("Drain (seconds)"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set.mock.calls[1][1]).toMatchObject({ stopGracePeriodSec: 45, drainSec: 7 });
  });

  it("prefills the stored values", () => {
    wrap(<DeploySettingsCard {...props} stopGracePeriodSec={30} drainSec={5} />);
    expect((screen.getByLabelText("Stop grace period (seconds)") as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText("Drain (seconds)") as HTMLInputElement).value).toBe("5");
  });

  it("a clustered app hides both fields and never sends them", async () => {
    const set = vi.spyOn(api, "setAppDeploySettings").mockResolvedValue({ ok: true });
    wrap(<DeploySettingsCard {...props} stopGracePeriodSec={null} drainSec={null} clustered />);
    expect(screen.queryByLabelText("Stop grace period (seconds)")).toBeNull();
    expect(screen.queryByLabelText("Drain (seconds)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect("stopGracePeriodSec" in set.mock.calls[0][1]).toBe(false);
    expect("drainSec" in set.mock.calls[0][1]).toBe(false);
  });
});

describe("DeploySettingsCard — post-cutover soak", () => {
  const props = { id: "a1", deployStrategy: "ROLLING", rollbackOnFailure: true, imagesToKeep: null, stopGracePeriodSec: null, drainSec: null };
  const soakInput = () => screen.getByLabelText("Post-cutover soak (seconds)") as HTMLInputElement;

  it("renders 0 as 0 and a stored 30 as 30", () => {
    const { unmount } = wrap(<DeploySettingsCard {...props} postCutoverSoakSec={0} />);
    expect(soakInput().value).toBe("0");
    unmount();
    wrap(<DeploySettingsCard {...props} postCutoverSoakSec={30} />);
    expect(soakInput().value).toBe("30");
  });

  it("saves numbers (and a blank field as 0)", async () => {
    const set = vi.spyOn(api, "setAppDeploySettings").mockResolvedValue({ ok: true });
    wrap(<DeploySettingsCard {...props} postCutoverSoakSec={30} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0][1]).toMatchObject({ postCutoverSoakSec: 30 });
    fireEvent.change(soakInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set.mock.calls[1][1]).toMatchObject({ postCutoverSoakSec: 0 });
  });

  it("shows the inactive hint when the app is not zero-downtime, and for a swarm app", () => {
    const a = wrap(<DeploySettingsCard {...props} postCutoverSoakSec={30} zeroDowntime={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/Not active: this app does not use a zero-downtime rolling deploy/);
    a.unmount();
    wrap(<DeploySettingsCard {...props} postCutoverSoakSec={30} zeroDowntime clustered />);
    expect(screen.getByRole("status").textContent).toMatch(/Not active/);
  });

  it("shows the probe count from the health interval, and warns when the window cannot trip a revert", () => {
    const a = wrap(<DeploySettingsCard {...props} postCutoverSoakSec={30} zeroDowntime healthInterval={3} />);
    expect(screen.getByRole("status").textContent).toMatch(/About 10 health checks/);
    expect(screen.queryByText(/could never trigger a revert/)).toBeNull();
    a.unmount();
    wrap(<DeploySettingsCard {...props} postCutoverSoakSec={10} zeroDowntime healthInterval={5} />);
    expect(screen.getByText(/About 2 health checks/)).toBeTruthy();
    expect(screen.getByText(/10s is under 3 health-check intervals, so it could never trigger a revert/)).toBeTruthy();
  });

  it("shows no soak hint when the soak is off", () => {
    wrap(<DeploySettingsCard {...props} postCutoverSoakSec={0} zeroDowntime />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("RestartPolicyCard — max retries", () => {
  it("shows the retries input only for on-failure, and clears it when switching away", async () => {
    const set = vi.spyOn(api, "setAppRestartPolicy").mockResolvedValue({ ok: true });
    wrap(<RestartPolicyCard id="a1" restartPolicy="on-failure" restartMaxRetries={5} />);
    const retries = screen.getByLabelText("Max retries") as HTMLInputElement;
    expect(retries.value).toBe("5");
    fireEvent.change(screen.getByLabelText("Restart policy"), { target: { value: "always" } });
    expect(screen.queryByLabelText("Max retries")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]).toEqual(["a1", "always"]); // no cap sent with another policy
    fireEvent.change(screen.getByLabelText("Restart policy"), { target: { value: "on-failure" } });
    expect((screen.getByLabelText("Max retries") as HTMLInputElement).value).toBe(""); // cleared locally on the way out
  });

  it("sends null for a blank cap and the number when filled (on-failure)", async () => {
    const set = vi.spyOn(api, "setAppRestartPolicy").mockResolvedValue({ ok: true });
    wrap(<RestartPolicyCard id="a1" restartPolicy="on-failure" restartMaxRetries={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0]).toEqual(["a1", "on-failure", null]);
    fireEvent.change(screen.getByLabelText("Max retries"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set.mock.calls[1]).toEqual(["a1", "on-failure", 3]);
  });
});

describe("SourceCard — Git provider link", () => {
  const src = (id: string, over: Partial<GitSource> = {}): GitSource => ({
    id, name: id, teamId: "t1", provider: "github", kind: "github", appId: "1", appSlug: null, installationId: null, htmlUrl: null,
    apiUrl: null, hasToken: true, cloneHost: "github.com", createdAt: "2026-11-01T00:00:00.000Z", canWrite: true, ...over,
  });
  const SOURCES = [
    src("gh", { name: "GitHub App" }),
    src("gt", { name: "Company Gitea", kind: "gitea", provider: "gitea", apiUrl: "https://git.example.com", cloneHost: "git.example.com" }),
    src("other-team", { name: "Foreign", teamId: "t2" }),
  ];
  const base = {
    id: "a1", source: "GIT" as const, gitUrl: "https://github.com/acme/app.git", gitBranch: "main", gitCommit: null, image: null, composePath: null,
    gitSourceId: null as string | null, teamId: "t1", hasGitToken: false, isPreview: false,
  };
  const select = () => screen.getByLabelText("Git provider") as HTMLSelectElement;
  const optionLabels = () => Array.from(select().options).filter((o) => !o.disabled).map((o) => o.textContent);
  let toasts: ToastInput[] = [];
  let off: () => void;
  beforeEach(() => {
    toasts = [];
    off = subscribeToast((x) => toasts.push(x));
    vi.spyOn(api, "listGitSources").mockResolvedValue(SOURCES);
  });
  afterEach(() => off());

  it("is hidden for an image app, a pasted compose app and a preview, and shown for git and git-compose", async () => {
    const list = vi.spyOn(api, "listGitSources");
    const { unmount } = wrap(<SourceCard {...base} source="IMAGE" gitUrl={null} image="nginx" />);
    expect(screen.queryByLabelText("Git provider")).toBeNull();
    unmount();
    const b = wrap(<SourceCard {...base} source="COMPOSE" gitUrl={null} composePath={null} />);
    expect(screen.queryByLabelText("Git provider")).toBeNull();
    b.unmount();
    const c = wrap(<SourceCard {...base} isPreview />);
    expect(screen.queryByLabelText("Git provider")).toBeNull();
    expect(list).not.toHaveBeenCalled();
    c.unmount();
    const d = wrap(<SourceCard {...base} />);
    await waitFor(() => expect(optionLabels().length).toBeGreaterThan(1));
    d.unmount();
    wrap(<SourceCard {...base} source="COMPOSE" composePath="docker-compose.yml" />);
    await waitFor(() => expect(optionLabels().length).toBeGreaterThan(1));
  });

  it("offers only this team's sources for the repo host", async () => {
    wrap(<SourceCard {...base} />);
    await waitFor(() => expect(optionLabels()).toContain("GitHub App · GitHub App"));
    expect(optionLabels()).toEqual(["None (public repo or personal access token)", "GitHub App · GitHub App"]);
  });

  it("keeps the linked source in the list even when its host no longer matches the repo", async () => {
    wrap(<SourceCard {...base} gitSourceId="gt" />);
    await waitFor(() => expect(optionLabels()).toContain("Company Gitea · Gitea"));
    expect(select().value).toBe("gt");
    expect(screen.getByText("Cloning with Company Gitea")).toBeTruthy();
    expect(screen.getByText("Takes precedence over a stored personal access token.")).toBeTruthy();
  });

  it("shows a missing-source note when the linked source isn't in the viewer's list", async () => {
    wrap(<SourceCard {...base} gitSourceId="vanished" />);
    await waitFor(() => expect(optionLabels()).toContain("Linked provider (not visible to you)"));
    expect(select().value).toBe("vanished");
    expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
  });

  it("selecting a provider sends exactly the source id, and None / Unlink send null", async () => {
    const set = vi.spyOn(api, "setAppSource").mockResolvedValue({ warnings: [] });
    wrap(<SourceCard {...base} />);
    await waitFor(() => expect(optionLabels()).toContain("GitHub App · GitHub App"));
    fireEvent.change(select(), { target: { value: "gh" } });
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { gitSourceId: "gh" }));
    await waitFor(() => expect(toasts.some((x) => x.type === "success")).toBe(true));
    cleanup();

    set.mockClear();
    wrap(<SourceCard {...base} gitSourceId="gh" />);
    await waitFor(() => expect(select().value).toBe("gh"));
    fireEvent.change(select(), { target: { value: "__none__" } });
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { gitSourceId: null }));
    cleanup();

    set.mockClear();
    wrap(<SourceCard {...base} gitSourceId="gh" />);
    await waitFor(() => expect(select().value).toBe("gh"));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { gitSourceId: null }));
  });

  it("never touches the URL/branch form's save state", async () => {
    vi.spyOn(api, "setAppSource").mockResolvedValue({ warnings: [] });
    wrap(<SourceCard {...base} />);
    await waitFor(() => expect(optionLabels()).toContain("GitHub App · GitHub App"));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select(), { target: { value: "gh" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an ssh repository disables the select and explains why", async () => {
    wrap(<SourceCard {...base} gitUrl="git@github.com:acme/app.git" />);
    await waitFor(() => expect(select()).toBeTruthy());
    expect(select().disabled).toBe(true);
    expect(screen.getByText(/clones with a deploy key/)).toBeTruthy();
  });

  it("a hub error toasts its message verbatim and reverts the select", async () => {
    vi.spyOn(api, "setAppSource").mockRejectedValue(new Error("the linked github source only authenticates github.com repositories"));
    wrap(<SourceCard {...base} />);
    await waitFor(() => expect(optionLabels()).toContain("GitHub App · GitHub App"));
    fireEvent.change(select(), { target: { value: "gh" } });
    await waitFor(() => expect(toasts.some((x) => x.type === "error" && x.message.includes("only authenticates github.com"))).toBe(true));
    await waitFor(() => expect(select().value).toBe("__none__"));
  });

  it("mentions a stored personal access token under None", async () => {
    wrap(<SourceCard {...base} hasGitToken />);
    await waitFor(() => expect(screen.getByText(/personal access token is stored/)).toBeTruthy());
  });
});

describe("BuildConfigCard — custom image name + alias tag", () => {
  const reg = { id: "r1", name: "GHCR", teamId: "t1", type: "ghcr", url: "ghcr.io", username: "bot", imagePrefix: "org", createdAt: "", canWrite: true };
  const props = { id: "a1", teamId: "t1", registryId: "r1", pushToRegistry: true, buildServerId: null };
  beforeEach(() => {
    vi.spyOn(api, "listRegistries").mockResolvedValue([reg]);
    vi.spyOn(api, "listServers").mockResolvedValue([]);
  });
  const name = () => screen.getByLabelText("Image name") as HTMLInputElement;
  const alias = () => screen.getByLabelText("Alias tag") as HTMLInputElement;
  const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  const ready = () => waitFor(() => expect(screen.getByRole("option", { name: "GHCR" })).toBeTruthy());

  it("shows the live preview: the immutable ref (always pushed) and the alias example (moves on every build, not on rollback)", async () => {
    wrap(<BuildConfigCard {...props} source="GIT" gitBranch="feat/x" pushImageName="team/web" pushImageTag="{branch}-{sha}" />);
    await ready();
    expect(screen.getByText("Immutable tag, always pushed")).toBeTruthy();
    expect(screen.getByText("ghcr.io/org/team/web:{deploymentId}")).toBeTruthy();
    expect(screen.getByText("Alias tag, moves on every build, not on rollback")).toBeTruthy();
    expect(screen.getByText("ghcr.io/org/team/web:feat-x-0123456789ab")).toBeTruthy();
  });

  it("previews the default tugra_<id> repo when no name is set, and shows no alias line without an alias", async () => {
    wrap(<BuildConfigCard {...props} source="IMAGE" />);
    await ready();
    expect(screen.getByText("ghcr.io/org/tugra_a1:{deploymentId}")).toBeTruthy();
    expect(screen.queryByText("Alias tag, moves on every build, not on rollback")).toBeNull();
  });

  it("offers the {sha}/{branch} chips for a GIT app only", async () => {
    wrap(<BuildConfigCard {...props} source="GIT" />);
    await ready();
    expect(screen.getByRole("button", { name: "Insert {sha}" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Insert {branch}" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert {sha}" }));
    expect(alias().value).toBe("{branch}{sha}");
    cleanup();
    wrap(<BuildConfigCard {...props} source="IMAGE" />);
    await ready();
    expect(screen.queryByRole("button", { name: "Insert {sha}" })).toBeNull();
  });

  it("an invalid name or alias shows an alert and disables Save; fixing it re-enables it", async () => {
    wrap(<BuildConfigCard {...props} source="IMAGE" />);
    await ready();
    fireEvent.change(name(), { target: { value: "tugra_other" } });
    expect(screen.getByText(/Not a valid image name/)).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(name(), { target: { value: "my-app" } });
    expect(save().disabled).toBe(false);
    fireEvent.change(alias(), { target: { value: "{sha}" } }); // IMAGE apps have no commit
    expect(screen.getByText(/Not a valid alias tag/)).toBeTruthy();
    expect(save().disabled).toBe(true);
    fireEvent.change(alias(), { target: { value: "latest" } });
    expect(save().disabled).toBe(false);
  });

  it("both inputs are disabled with the hint when nothing is pushed, and are cleared when the registry is cleared", async () => {
    wrap(<BuildConfigCard {...props} registryId={null} pushToRegistry={false} source="IMAGE" />);
    await ready();
    expect(name().disabled).toBe(true);
    expect(alias().disabled).toBe(true);
    expect(screen.getByText(/Pick a registry and enable push/)).toBeTruthy();
    cleanup();
    wrap(<BuildConfigCard {...props} source="IMAGE" pushImageName="team/web" pushImageTag="stable" />);
    await ready();
    expect(name().value).toBe("team/web");
    fireEvent.change(screen.getByLabelText("Registry"), { target: { value: "" } });
    await waitFor(() => expect(name().value).toBe(""));
    expect(alias().value).toBe("");
  });

  it("sends the two fields only when they changed (an untouched card keeps the old payload)", async () => {
    const set = vi.spyOn(api, "setAppBuildConfig").mockResolvedValue({ ok: true });
    wrap(<BuildConfigCard {...props} source="IMAGE" />);
    await ready();
    fireEvent.click(save());
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set.mock.calls[0][1]).toEqual({ registryId: "r1", pushToRegistry: true, buildServerId: null });
    fireEvent.change(name(), { target: { value: "team/web" } });
    fireEvent.change(alias(), { target: { value: "stable" } });
    fireEvent.click(save());
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(set.mock.calls[1][1]).toEqual({ registryId: "r1", pushToRegistry: true, buildServerId: null, pushImageName: "team/web", pushImageTag: "stable" });
  });

  it("clearing a stored name sends an explicit null", async () => {
    const set = vi.spyOn(api, "setAppBuildConfig").mockResolvedValue({ ok: true });
    wrap(<BuildConfigCard {...props} source="IMAGE" pushImageName="team/web" />);
    await ready();
    fireEvent.change(name(), { target: { value: "" } });
    fireEvent.click(save());
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][1]).toMatchObject({ pushImageName: null });
    expect("pushImageTag" in set.mock.calls[0][1]).toBe(false);
  });

  it("maps a 409 to the 'repository already taken' message", async () => {
    vi.spyOn(api, "setAppBuildConfig").mockRejectedValue(new ApiError(409, "another app already pushes to that repository in this registry"));
    wrap(<BuildConfigCard {...props} source="IMAGE" />);
    await ready();
    fireEvent.change(name(), { target: { value: "taken" } });
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByText("Another app already pushes to that repository in this registry.")).toBeTruthy());
  });

  it("a COMPOSE app gets no name/alias inputs", async () => {
    wrap(<BuildConfigCard {...props} source="COMPOSE" />);
    await ready();
    expect(screen.queryByLabelText("Image name")).toBeNull();
  });
});

describe("DeployHooksCard — compose service picker", () => {
  it("a classic app has no service picker and sends the old payload", async () => {
    const set = vi.spyOn(api, "setAppDeployHooks").mockResolvedValue({ ok: true });
    wrap(<DeployHooksCard id="a1" pre="migrate" post={null} />);
    expect(screen.queryByLabelText("Service")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][1]).toEqual({ preDeployCommand: "migrate", postDeployCommand: null });
  });

  it("a pasted compose offers a <select> over its services; Save is blocked until one is picked", async () => {
    const set = vi.spyOn(api, "setAppDeployHooks").mockResolvedValue({ ok: true });
    wrap(<DeployHooksCard id="a1" pre={null} post={null} source="COMPOSE" composeHookService={null} composeServices={["web", "api"]} />);
    const select = screen.getByLabelText("Service") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(screen.queryByRole("button", { name: "Detect services" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("npm run db:migrate"), { target: { value: "migrate" } });
    expect(screen.getByText("Pick the service the hook runs in.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(select, { target: { value: "api" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][1]).toEqual({ preDeployCommand: "migrate", postDeployCommand: null, composeHookService: "api" });
  });

  it("clearing both hooks sends composeHookService null (no service required)", async () => {
    const set = vi.spyOn(api, "setAppDeployHooks").mockResolvedValue({ ok: true });
    wrap(<DeployHooksCard id="a1" pre="migrate" post={null} source="COMPOSE" composeHookService="api" composeServices={["api"]} />);
    fireEvent.change(screen.getByPlaceholderText("npm run db:migrate"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][1]).toEqual({ preDeployCommand: null, postDeployCommand: null, composeHookService: null });
  });

  it("a git-compose app shows a text input + 'Detect services' that fills a select from the preview endpoint", async () => {
    const preview = vi.spyOn(api, "previewAppCompose").mockResolvedValue({ resolvedCompose: "x", services: ["web", "worker"], sha256: "s", redactions: 0, warnings: [], generatedAt: "now" });
    wrap(<DeployHooksCard id="a1" pre={null} post={null} source="COMPOSE" composeHookService={null} composeServices={[]} />);
    expect((screen.getByLabelText("Service") as HTMLElement).tagName).toBe("INPUT");
    fireEvent.click(screen.getByRole("button", { name: "Detect services" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith("a1"));
    await waitFor(() => expect((screen.getByLabelText("Service") as HTMLElement).tagName).toBe("SELECT"));
    expect(screen.getByRole("option", { name: "worker" })).toBeTruthy();
  });

  it("shows the first-deploy / dependencies caveat on the pre-hook and the best-effort note on the post-hook", () => {
    wrap(<DeployHooksCard id="a1" pre={null} post={null} source="COMPOSE" composeServices={["api"]} />);
    expect(screen.getByText(/dependencies are started/)).toBeTruthy();
    expect(screen.getByText(/A failure is logged and ignored/)).toBeTruthy();
  });
});

describe("BuildSettingsCard — inline Dockerfile", () => {
  const props = {
    id: "a1",
    buildType: "DOCKERFILE" as const,
    dockerfilePath: "docker/Dockerfile",
    dockerBuildTarget: null,
    baseDirectory: null,
    buildCommand: null,
    outputDir: null,
    nixpacksInstallCmd: null,
    nixpacksBuildCmd: null,
    nixpacksStartCmd: null,
    gitSubmodules: false,
    gitLfs: false,
    gitShallowClone: true,
    disableBuildCache: false,
    injectEnvAsBuildArgs: false,
    sourceCommitMode: "RUNTIME" as const,
  };
  const source = () => screen.getByLabelText("Dockerfile source") as HTMLSelectElement;

  it("repo source is the default: no textarea, the path input is enabled, and the payload carries no inline text", async () => {
    const set = vi.spyOn(api, "setAppBuild").mockResolvedValue({ ok: true });
    wrap(<BuildSettingsCard {...props} />);
    expect(source().value).toBe("repo");
    expect(screen.queryByLabelText("Dockerfile")).toBeNull();
    expect((screen.getByLabelText(/Dockerfile path/) as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect("inlineDockerfile" in set.mock.calls[0][1]).toBe(false);
  });

  it("inline source shows the textarea with a byte counter, disables the path input and says it is overridden", () => {
    wrap(<BuildSettingsCard {...props} />);
    fireEvent.change(source(), { target: { value: "inline" } });
    const ta = screen.getByLabelText("Dockerfile") as HTMLTextAreaElement;
    expect((screen.getByLabelText(/Dockerfile path/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("The inline Dockerfile is used instead of this path.")).toBeTruthy();
    fireEvent.change(ta, { target: { value: "FROM alpine\n" } });
    expect(screen.getByText("12 of 49152 bytes")).toBeTruthy();
    expect(screen.getByText(/The repository is still the build context/)).toBeTruthy();
  });

  it("starts in inline mode with the stored text, and sends it (replace semantics) on save", async () => {
    const set = vi.spyOn(api, "setAppBuild").mockResolvedValue({ ok: true });
    wrap(<BuildSettingsCard {...props} inlineDockerfile={"FROM node:22\nCMD [\"node\"]\n"} />);
    expect(source().value).toBe("inline");
    expect((screen.getByLabelText("Dockerfile") as HTMLTextAreaElement).value).toContain("FROM node:22");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect(set.mock.calls[0][1]).toMatchObject({ buildType: "DOCKERFILE", dockerfilePath: "docker/Dockerfile", inlineDockerfile: "FROM node:22\nCMD [\"node\"]\n" });
  });

  it("switching back to the repository file omits the inline field (the hub clears it)", async () => {
    const set = vi.spyOn(api, "setAppBuild").mockResolvedValue({ ok: true });
    wrap(<BuildSettingsCard {...props} inlineDockerfile={"FROM node:22\n"} />);
    fireEvent.change(source(), { target: { value: "repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(set).toHaveBeenCalled());
    expect("inlineDockerfile" in set.mock.calls[0][1]).toBe(false);
  });

  it("blocks Save for a Dockerfile without FROM or over 48 KiB", () => {
    wrap(<BuildSettingsCard {...props} />);
    fireEvent.change(source(), { target: { value: "inline" } });
    const ta = screen.getByLabelText("Dockerfile") as HTMLTextAreaElement;
    const saveBtn = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.change(ta, { target: { value: "RUN echo hi" } });
    expect(screen.getByText(/must start with FROM/)).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(ta, { target: { value: "FROM x\n" + "#".repeat(49 * 1024) } });
    expect(screen.getByText("The Dockerfile is larger than 48 KiB.")).toBeTruthy();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(ta, { target: { value: "FROM x\n" } });
    expect(saveBtn().disabled).toBe(false);
  });
});

describe("CredentialsCard — deploy key feedback", () => {
  const wrapC = (ui: React.ReactElement) =>
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  const card = () => (
    <CredentialsCard id="a1" source="GIT" gitUrl="git@github.com:o/r.git" composePath={null} hasGitToken={false} hasGitSshKey gitSshPublicKey="ssh-ed25519 AAAA" registryUrl={null} registryUser={null} />
  );
  let toasts: string[];
  let off: () => void;
  beforeEach(() => {
    toasts = [];
    off = subscribeToast((x) => toasts.push(x.message));
  });
  afterEach(() => off());

  it("Regenerate asks first (the old key stops working) and toasts when done", async () => {
    const gen = vi.spyOn(api, "generateGitSshKey").mockResolvedValue({} as never);
    wrapC(card());
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(await screen.findByText(/current key stops working immediately/)).toBeTruthy();
    expect(gen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(gen).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toasts).toContain("Deploy key generated — add the public key to the repository"));
  });

  it("Remove is confirmed, and Copy says Copied", async () => {
    const rm = vi.spyOn(api, "removeGitSshKey").mockResolvedValue({} as never);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    wrapC(card());
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(toasts).toContain("Copied"));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(rm).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(rm).toHaveBeenCalledTimes(1));
  });
});
