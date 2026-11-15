import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "../../../i18n/provider";
import { api } from "../../../lib/api";
import { KeysExportModal } from "./keys-export-modal";

afterEach(() => { vi.restoreAllMocks(); cleanup(); });

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <I18nProvider><KeysExportModal onClose={() => undefined} /></I18nProvider>
    </QueryClientProvider>,
  );
const fill = (a: string, b: string) => {
  fireEvent.change(screen.getByLabelText("Passphrase (min 12 characters)"), { target: { value: a } });
  fireEvent.change(screen.getByLabelText("Repeat passphrase"), { target: { value: b } });
};

describe("KeysExportModal", () => {
  it("rejects a passphrase under 12 characters without calling the API", () => {
    const spy = vi.spyOn(api, "exportDestinationKeys");
    show();
    fill("short", "short");
    fireEvent.click(screen.getByRole("button", { name: "Download sealed file" }));
    expect(screen.getByText("The passphrase must be at least 12 characters.")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects mismatching passphrases", () => {
    const spy = vi.spyOn(api, "exportDestinationKeys");
    show();
    fill("a-long-passphrase-1", "a-long-passphrase-2");
    fireEvent.click(screen.getByRole("button", { name: "Download sealed file" }));
    expect(screen.getByText("The passphrases do not match.")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it("exports, downloads the .enc client-side, and warns about undecryptable destinations", async () => {
    vi.spyOn(api, "exportDestinationKeys").mockResolvedValue({
      filename: "tugra-destination-keys-20261115.enc", format: "openssl-aes-256-cbc-pbkdf2-sha256-600000",
      contentBase64: btoa("Salted__12345678xxxx"), destinationCount: 2, undecryptable: ["d9"],
    });
    let blob: Blob | undefined;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => { blob = b; return "blob:x"; };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
    let name = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { name = this.download; });
    show();
    fill("a-long-passphrase-1", "a-long-passphrase-1");
    fireEvent.click(screen.getByRole("button", { name: "Download sealed file" }));
    await waitFor(() => expect(api.exportDestinationKeys).toHaveBeenCalledWith("a-long-passphrase-1"));
    expect(await screen.findByText(/Downloaded tugra-destination-keys-20261115\.enc \(2 destination key\(s\)\)/)).toBeTruthy();
    expect(name).toBe("tugra-destination-keys-20261115.enc");
    expect(await blob!.text()).toBe("Salted__12345678xxxx");
    expect(screen.getByRole("alert").textContent).toContain("d9");
  });
});
