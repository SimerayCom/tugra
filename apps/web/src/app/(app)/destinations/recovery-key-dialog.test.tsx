import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { I18nProvider } from "../../../i18n/provider";
import { RecoveryKeyDialog, slugify } from "./recovery-key-dialog";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); window.sessionStorage.clear(); });

const KEY = "k3y-AbCdEf0123456789_-abcdefghijklmnopqrstuv";
const show = (onClose = vi.fn()) => {
  render(<I18nProvider><RecoveryKeyDialog name="Prod S3" recoveryKey={KEY} onClose={onClose} /></I18nProvider>);
  return onClose;
};

describe("RecoveryKeyDialog", () => {
  it("shows the key; Done stays disabled until 'I saved this key offline' is ticked", () => {
    const onClose = show();
    expect(screen.getByTestId("recovery-key").textContent).toBe(KEY);
    const done = screen.getByRole("button", { name: "Done" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(done);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("I saved this key offline"));
    expect(done.disabled).toBe(false);
    fireEvent.click(done);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("'Skip for now' closes without the tick", () => {
    const onClose = show();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("never persists the key to localStorage or sessionStorage", () => {
    show();
    fireEvent.click(screen.getByLabelText("I saved this key offline"));
    for (const store of [window.localStorage, window.sessionStorage]) {
      const dump = JSON.stringify(Object.fromEntries(Object.keys(store).map((k) => [k, store.getItem(k)])));
      expect(dump).not.toContain(KEY);
    }
  });

  it("Copy writes the key to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("Download saves a .txt named for the destination, with the key and the hand-decrypt recipe", async () => {
    let blob: Blob | undefined;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => { blob = b; return "blob:x"; };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => undefined;
    let name = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { name = this.download; });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Download .txt" }));
    expect(name).toBe("tugra-destination-prod-s3-recovery-key.txt");
    const text = await blob!.text();
    expect(text).toContain(KEY);
    expect(text).toContain("mc cat <object>.gpg | gpg --batch --passphrase \"$KEY\" -d | gunzip");
  });

  it("slugify yields a safe file-name fragment", () => {
    expect(slugify("Prod S3 / eu-west!")).toBe("prod-s3-eu-west");
    expect(slugify("!!!")).toBe("destination");
  });
});
