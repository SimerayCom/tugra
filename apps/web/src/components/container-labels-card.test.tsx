import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { ConfirmProvider } from "./confirm";
import { ToastProvider } from "./toast";
import { ContainerLabelsCard, parsePasted } from "./container-labels-card";
import { api } from "../lib/api";
import { translate } from "../i18n/translate";
import apps from "../i18n/locales/en/apps.json";
import type { AppLabelsView } from "../lib/types";

afterEach(cleanup);

let qc: QueryClient;
const writeText = vi.fn();
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.restoreAllMocks();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

const view = (over: Partial<AppLabelsView> = {}): AppLabelsView => ({
  engine: "docker",
  editable: true,
  editableReason: null,
  applyMode: "next_deploy",
  tugra: [
    { scope: "container", key: "traefik.enable", value: "true", masked: false, purpose: "traefik_routing" },
    { scope: "container", key: "traefik.http.middlewares.x-ba.basicauth.users", value: null, masked: true, purpose: "traefik_routing" },
    { scope: "container", key: "tugra.alias", value: "web", masked: false, purpose: "alias" },
  ],
  custom: [],
  fromDockerOptions: [],
  reservedPrefixes: ["traefik.", "tugra.", "com.docker.compose.", "com.docker.swarm.", "com.docker.stack."],
  limits: { maxCount: 3, keyMax: 128, valueMax: 20, totalBytes: 16384, keyPattern: "^[A-Za-z0-9][A-Za-z0-9._/@:-]*$" },
  notes: [],
  ...over,
});

type Props = Partial<React.ComponentProps<typeof ContainerLabelsCard>>;
const mount = (v: AppLabelsView, props: Props = {}) => {
  vi.spyOn(api, "getAppLabels").mockResolvedValue(v);
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>
          <ConfirmProvider>
            <ContainerLabelsCard id="a1" source="IMAGE" clusterId={null} isPreview={false} customLabels={null} {...props} />
          </ConfirmProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
};
const keyInputs = () => screen.queryAllByLabelText("Label key") as HTMLInputElement[];
const valueInputs = () => screen.queryAllByLabelText("Label value") as HTMLInputElement[];
const save = () => screen.getByRole("button", { name: "Save" });

describe("ContainerLabelsCard", () => {
  it("renders the applied labels read-only, with a masked row that copies only its key", async () => {
    mount(view());
    expect(await screen.findByText("traefik.enable")).toBeTruthy();
    expect(screen.getByText("tugra.alias")).toBeTruthy();
    expect(screen.getAllByText("hidden")).toHaveLength(1); // the basic-auth hash is never shown
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    expect(writeText).toHaveBeenCalledWith("traefik.http.middlewares.x-ba.basicauth.users");
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    expect(writeText).toHaveBeenCalledWith("traefik.enable=true");
  });

  it("shows the empty state and the notes", async () => {
    mount(view({ tugra: [], notes: ["needs_domain"] }));
    expect(await screen.findByText("Tugra applies no labels to this app right now.")).toBeTruthy();
    expect(screen.getByText("Routing labels appear once the app has a domain.")).toBeTruthy();
  });

  it("adds and removes rows; Save is dirty-gated and PUTs a sorted map", async () => {
    const set = vi.spyOn(api, "setAppCustomLabels").mockResolvedValue({ ok: true });
    mount(view(), { customLabels: { zeta: "1" } });
    await screen.findByText("traefik.enable");
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    fireEvent.change(keyInputs()[1], { target: { value: "alpha" } });
    fireEvent.change(valueInputs()[1], { target: { value: "x=y" } });
    expect(save()).toHaveProperty("disabled", false);
    fireEvent.click(save());
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { alpha: "x=y", zeta: "1" }));
    // remove a row
    fireEvent.click(screen.getAllByRole("button", { name: "Remove label" })[0]);
    expect(keyInputs()).toHaveLength(1);
  });

  it("ignores a fully blank row on save", async () => {
    const set = vi.spyOn(api, "setAppCustomLabels").mockResolvedValue({ ok: true });
    mount(view(), { customLabels: { a: "1" } });
    await screen.findByText("traefik.enable");
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    expect(save()).toHaveProperty("disabled", true); // a blank row alone is not a change
    fireEvent.change(valueInputs()[0], { target: { value: "2" } });
    fireEvent.click(save());
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", { a: "2" }));
  });

  it("validates inline from the SERVER-provided prefixes, pattern and limits, and blocks Save", async () => {
    mount(view());
    await screen.findByText("traefik.enable");
    const add = () => fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    add();
    fireEvent.change(keyInputs()[0], { target: { value: "Traefik.x" } });
    expect(screen.getByText("Traefik.x is reserved: Tugra owns ingress routing on the shared proxy.")).toBeTruthy();
    expect(save()).toHaveProperty("disabled", true);
    fireEvent.change(keyInputs()[0], { target: { value: "com.docker.compose.project" } });
    expect(screen.getByText(/is reserved: Docker Compose project/)).toBeTruthy();
    fireEvent.change(keyInputs()[0], { target: { value: "bad key" } });
    expect(screen.getByText('"bad key" is not a valid label key.')).toBeTruthy();
    fireEvent.change(keyInputs()[0], { target: { value: "ok" } });
    fireEvent.change(valueInputs()[0], { target: { value: "x".repeat(21) } }); // valueMax is 20 in this response
    expect(screen.getByText(/value of "ok" is too long/)).toBeTruthy();
    fireEvent.change(valueInputs()[0], { target: { value: "fine" } });
    add();
    fireEvent.change(keyInputs()[1], { target: { value: "OK" } });
    expect(screen.getByText(/"OK" appears more than once/)).toBeTruthy();
    fireEvent.change(keyInputs()[1], { target: { value: "b" } });
    add();
    fireEvent.change(keyInputs()[2], { target: { value: "c" } });
    add();
    fireEvent.change(keyInputs()[3], { target: { value: "d" } }); // 4 > maxCount 3
    expect(screen.getByText("At most 3 custom labels are allowed.")).toBeTruthy();
    expect(save()).toHaveProperty("disabled", true);
  });

  it("a prefix the server adds is enforced without a web change", async () => {
    mount(view({ reservedPrefixes: ["acme."] }));
    await screen.findByText("traefik.enable");
    fireEvent.click(screen.getByRole("button", { name: "Add label" }));
    fireEvent.change(keyInputs()[0], { target: { value: "traefik.ok" } }); // no longer reserved in this response
    expect(screen.queryByText(/is reserved/)).toBeNull();
    fireEvent.change(keyInputs()[0], { target: { value: "ACME.x" } });
    expect(screen.getByText(/ACME\.x is reserved/)).toBeTruthy();
  });

  it("the paste helper splits at the first =, skips blanks and comments, and merges case-insensitively", async () => {
    mount(view(), { customLabels: { Team: "old" } });
    await screen.findByText("traefik.enable");
    fireEvent.click(screen.getByRole("button", { name: "Paste KEY=VALUE lines" }));
    fireEvent.change(screen.getByLabelText("Paste KEY=VALUE lines"), { target: { value: "# comment\n\nteam=core\nurl=https://x/?a=b\nflag" } });
    fireEvent.click(screen.getByRole("button", { name: "Add pasted labels" }));
    const pairs = keyInputs().map((k, i) => [k.value, valueInputs()[i].value]);
    expect(pairs).toEqual(expect.arrayContaining([["team", "core"], ["url", "https://x/?a=b"], ["flag", ""]]));
    expect(pairs.some(([k]) => k === "Team")).toBe(false);
    expect(parsePasted("a=b=c\n  \n#x\nk")).toEqual([{ key: "a", value: "b=c" }, { key: "k", value: "" }]);
  });

  it("Reset confirms, then PUTs {labels:{}}; it is disabled when nothing is stored", async () => {
    const set = vi.spyOn(api, "setAppCustomLabels").mockResolvedValue({ ok: true });
    const { unmount } = mount(view(), { customLabels: null });
    await screen.findByText("traefik.enable");
    expect(screen.getByRole("button", { name: "Reset to defaults" })).toHaveProperty("disabled", true);
    unmount();
    mount(view(), { customLabels: { a: "1" } });
    await screen.findByText("traefik.enable");
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(set).not.toHaveBeenCalled(); // not until confirmed
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("a1", {}));
  });

  it("compose shows the note and no editor", async () => {
    mount(view({ engine: "compose", editable: false, editableReason: "compose" }), { source: "COMPOSE" });
    expect(await screen.findByText("traefik.enable")).toBeTruthy();
    expect(screen.getByText(/Compose apps declare their labels in the compose file/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add label" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("a preview shows the note and no editor", async () => {
    mount(view({ editable: false, editableReason: "preview" }), { isPreview: true });
    expect(await screen.findByText("Preview apps do not take custom labels.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add label" })).toBeNull();
  });

  it("groups compose rows by service", async () => {
    mount(
      view({
        engine: "compose",
        editable: false,
        tugra: [
          { scope: "service:web", key: "traefik.enable", value: "true", masked: false, purpose: "traefik_routing" },
          { scope: "service:api", key: "tugra.config-mount.0", value: "abc", masked: false, purpose: "config_mount_fp" },
        ],
      }),
      { source: "COMPOSE" },
    );
    expect(await screen.findByText("Service web")).toBeTruthy();
    expect(screen.getByText("Service api")).toBeTruthy();
    expect(screen.getByText("config fingerprint")).toBeTruthy();
  });

  it("lists labels from Docker options read-only and explains where to edit them", async () => {
    mount(view({ fromDockerOptions: [{ key: "legacy", value: "1" }] }));
    expect(await screen.findByText("legacy=1")).toBeTruthy();
    expect(screen.getByText(/Custom Docker options card/)).toBeTruthy();
  });

  it("explains the swarm container-label semantics", async () => {
    mount(view({ engine: "swarm" }), { clusterId: "c1" });
    expect(await screen.findByText(/On a swarm these are container labels/)).toBeTruthy();
  });

  it("surfaces a load failure without crashing", async () => {
    vi.spyOn(api, "getAppLabels").mockRejectedValue(new Error("boom"));
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider><ToastProvider><ConfirmProvider><ContainerLabelsCard id="a1" source="IMAGE" clusterId={null} isPreview={false} customLabels={null} /></ConfirmProvider></ToastProvider></I18nProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Could not load the labels.")).toBeTruthy();
    expect(save()).toHaveProperty("disabled", true);
  });
});

describe("i18n keys", () => {
  it("every label string the card uses is present in apps.json", () => {
    const keys = [
      "containerLabels", "containerLabelsDesc", "labelsApplied", "labelsAppliedHint", "labelsNoneApplied", "labelsCustom", "labelsAdd",
      "labelsKey", "labelsValue", "labelsRemove", "labelsPaste", "labelsPastePlaceholder", "labelsReset", "labelsResetConfirmTitle",
      "labelsResetConfirmBody", "labelsFromDockerOptions", "labelsFromDockerOptionsHint", "labelsMasked", "labelsCopyKey", "labelsReserved",
      "labelsInvalidKey", "labelsDuplicate", "labelsTooMany", "labelsValueInvalid", "labelsComposeNote", "labelsSwarmNote", "labelsPreviewNote",
      "labelsPurposeTraefikRouting", "labelsPurposeProxyNetworkPin", "labelsPurposeAlias", "labelsPurposeConfigMountFp", "labelsWhyTraefik",
      "labelsWhyTugra", "labelsWhyCompose", "labelsWhySwarm", "labelsWhyStack", "labelsNoteRollingHealth", "labelsNoteNeedsDomain",
      "labelsNoteComposeUserLabels", "labelsNoteImageLabels", "labelsNoteSwarmContainer", "labelsNoteSwarmRuntime", "labelsAppliedNextDeploy",
      "cloneWarn_custom_labels_dropped",
    ];
    for (const k of keys) expect(translate({ apps }, `apps.${k}`), k).not.toBe(`apps.${k}`);
    expect(translate({ apps }, "apps.dockerOptionsDesc")).toContain("com.docker.compose|swarm|stack.");
  });
});
