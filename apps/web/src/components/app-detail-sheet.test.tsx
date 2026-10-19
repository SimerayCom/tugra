import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { AppDetailSheet } from "./app-detail-sheet";
import type { Template } from "../lib/types";

afterEach(cleanup);
const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

const immich: Template = {
  slug: "immich", name: "Immich", description: "Self-hosted photo & video backup.", category: "productivity",
  featured: true, tagline: "Google Photos alternative", badges: ["db"], documentation: "https://immich.app/docs",
};

describe("AppDetailSheet", () => {
  it("shows name, tagline, description, badges and a docs link; Install hands off", () => {
    const onInstall = vi.fn();
    wrap(<AppDetailSheet template={immich} onInstall={onInstall} onClose={vi.fn()} />);
    expect(screen.getByText("Immich")).toBeTruthy();
    expect(screen.getByText("Google Photos alternative")).toBeTruthy();
    expect(screen.getByText("Self-hosted photo & video backup.")).toBeTruthy();
    expect(screen.getByText("Database")).toBeTruthy();
    expect(screen.getByRole("link", { name: /documentation/i }).getAttribute("href")).toBe("https://immich.app/docs");
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("reflects an existing install: a Running badge + 'Install another'", () => {
    wrap(<AppDetailSheet template={immich} installed={{ count: 1, running: true, firstId: "a1", url: "https://x" }} onInstall={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install another" })).toBeTruthy();
  });

  it("Cancel closes the sheet", () => {
    const onClose = vi.fn();
    wrap(<AppDetailSheet template={immich} onInstall={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
