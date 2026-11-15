import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../../i18n/provider";
import { KEYS } from "../../../lib/appearance";
import { AppearanceCard } from "./appearance-card";

const wrap = () =>
  render(
    <I18nProvider>
      <AppearanceCard />
    </I18nProvider>,
  );
const root = () => document.documentElement;
const radio = (group: string, name: string) => {
  const g = screen.getByRole("radiogroup", { name: group });
  return Array.from(g.querySelectorAll<HTMLElement>('[role="radio"]')).find((el) => el.textContent?.trim() === name)!;
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  root().removeAttribute("style");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppearanceCard", () => {
  it("renders every option group with the defaults selected", () => {
    wrap();
    expect(radio("Color theme", "Dark")).toHaveAttribute("aria-checked", "true");
    expect(radio("Color theme", "Light")).toHaveAttribute("aria-checked", "false");
    expect(radio("UI scale", "100%")).toHaveAttribute("aria-checked", "true");
    expect(radio("Page width", "Full")).toHaveAttribute("aria-checked", "true");
    expect(radio("Navigation style", "Default")).toHaveAttribute("aria-checked", "true");
    expect(radio("Style", "Flat")).toHaveAttribute("aria-checked", "true");
    expect(radio("Chart times", "Your time")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByTestId("appearance-custom")).toBeNull();
  });

  it("switches options, persists them and applies them to <html>", () => {
    wrap();
    fireEvent.click(radio("Color theme", "Light"));
    expect(radio("Color theme", "Light")).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem(KEYS.theme)).toBe("light");
    expect(root().getAttribute("data-theme")).toBe("light");

    fireEvent.click(radio("UI scale", "80%"));
    expect(root().getAttribute("data-ui-scale")).toBe("80");
    fireEvent.click(radio("Page width", "Centered"));
    expect(root().getAttribute("data-page-width")).toBe("centered");
    fireEvent.click(radio("Navigation style", "Floating"));
    expect(root().getAttribute("data-nav-style")).toBe("floating");
    fireEvent.click(radio("Style", "3D"));
    expect(root().getAttribute("data-ui-style")).toBe("3d");
    fireEvent.click(radio("Chart times", "Your time + UTC"));
    expect(localStorage.getItem(KEYS.chartTimes)).toBe("localUtc");
  });

  it("Custom reveals presets and the two colour pickers", () => {
    wrap();
    fireEvent.click(radio("Color theme", "Custom"));
    expect(root().getAttribute("data-theme")).toBe("custom");
    expect(screen.getByTestId("appearance-custom")).toBeInTheDocument();
    expect(radio("Presets", "Tugra Gold")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(radio("Presets", "Rose"));
    expect(radio("Presets", "Rose")).toHaveAttribute("aria-checked", "true");
    expect(root().style.getPropertyValue("--c-a")).toBe("#fb7185");

    fireEvent.change(screen.getByLabelText("Accent color"), { target: { value: "#22c55e" } });
    expect(root().style.getPropertyValue("--c-a")).toBe("#22c55e");
    expect(root().style.getPropertyValue("--c-on-a")).toBe("#0d0d11");
    expect(radio("Presets", "Rose")).toHaveAttribute("aria-checked", "false"); // no longer exactly a preset
    fireEvent.change(screen.getByLabelText("Surface tint"), { target: { value: "#334155" } });
    expect(JSON.parse(localStorage.getItem(KEYS.custom) ?? "{}")).toMatchObject({ accent: "#22c55e", tint: "#334155" });
  });

  it("restores the saved choices on mount", () => {
    localStorage.setItem(KEYS.uiStyle, "3d");
    localStorage.setItem(KEYS.pageWidth, "centered");
    wrap();
    expect(radio("Style", "3D")).toHaveAttribute("aria-checked", "true");
    expect(radio("Page width", "Centered")).toHaveAttribute("aria-checked", "true");
  });
});
