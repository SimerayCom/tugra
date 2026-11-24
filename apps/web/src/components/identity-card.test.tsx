import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { IdentityCard, type IdentityLabels } from "./identity-card";
import { I18nProvider } from "../i18n/provider";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  crop: vi.fn(async () => "AAAA"),
  suggest: vi.fn(async (): Promise<string | null> => "#336699"),
}));
vi.mock("./toast", () => ({ useToast: () => mocks.toast }));
vi.mock("../lib/icon", () => ({ cropToPngBase64: mocks.crop, suggestColorFromImage: mocks.suggest }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const labels: IdentityLabels = {
  hint: "Hint", upload: "Upload icon", replace: "Replace icon", remove: "Remove", uploaded: "Icon updated",
  removed: "Icon removed", tooLarge: "Too large", readFailed: "Read failed", failed: "Failed",
};

function draw(over: Partial<React.ComponentProps<typeof IdentityCard>> = {}) {
  const props = {
    name: "Acme", iconUrl: null, color: null, canEdit: true, fallbackIcon: Users, labels,
    onSaveIcon: vi.fn(async () => ({})), onRemoveIcon: vi.fn(async () => ({})), onSaveColor: vi.fn(async () => ({})), onChanged: vi.fn(),
    ...over,
  };
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}><I18nProvider><IdentityCard {...props} /></I18nProvider></QueryClientProvider>,
  );
  return { props, view };
}

const pick = (container: HTMLElement) => {
  const input = container.querySelector("input[type=file]") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], "logo.png", { type: "image/png" })] } });
};

describe("IdentityCard", () => {
  it("saves a colour immediately and refreshes", async () => {
    const { props } = draw();
    fireEvent.click(screen.getByRole("radio", { name: "Use Blue" }));
    await waitFor(() => expect(props.onSaveColor).toHaveBeenCalledWith("#0091ff"));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
  });

  it("after an upload, suggests the icon's dominant colour and applies it in one click", async () => {
    const { props, view } = draw();
    pick(view.container);
    await waitFor(() => expect(props.onSaveIcon).toHaveBeenCalledWith("AAAA"));
    const use = await screen.findByRole("button", { name: "Use #336699" });
    fireEvent.click(use);
    await waitFor(() => expect(props.onSaveColor).toHaveBeenCalledWith("#336699"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use #336699" })).toBeNull());
  });

  it("shows no suggestion when the image has no usable colour", async () => {
    mocks.suggest.mockResolvedValueOnce(null);
    const { props, view } = draw();
    pick(view.container);
    await waitFor(() => expect(props.onSaveIcon).toHaveBeenCalled());
    expect(screen.queryByText("Use the color from your icon?")).toBeNull();
  });

  it("offers no suggestion if the icon upload fails", async () => {
    const { props, view } = draw({ onSaveIcon: vi.fn(async () => { throw new Error("boom"); }) });
    pick(view.container);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("boom", "error"));
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Use the color from your icon?")).toBeNull();
  });

  it("is read-only for viewers: no upload, no colour picker", () => {
    draw({ canEdit: false });
    expect(screen.queryByRole("button", { name: "Upload icon" })).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
