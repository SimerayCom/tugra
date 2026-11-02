import { describe, it, expect } from "vitest";
import { NAV, DESTS, noticeVisible } from "./shell";
import type { InstanceUpdateNotice } from "../lib/types";
import { navForMode, isHomeAllowed } from "../lib/ui-mode";
import { translate } from "../i18n/translate";
import en from "../i18n/locales/en";

describe("sidebar NAV", () => {
  it("defines an icon for every nav item (no bare text entries)", () => {
    for (const group of NAV) {
      for (const item of group.items) {
        expect(item.icon, `${item.key} is missing an icon`).toBeTruthy();
      }
    }
  });

  it("is Projects-centric: Apps/Databases are not top-level nav items", () => {
    const keys = NAV.flatMap((g) => g.items.map((i) => i.key));
    expect(keys).not.toContain("apps");
    expect(keys).not.toContain("databases");
    expect(keys).toContain("projects");
  });
});

describe("home mode nav", () => {
  it("shows only Home, App Store and Settings in home mode", () => {
    const keys = navForMode(NAV, "home").flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toEqual(["home", "appStore", "settings"]);
  });

  it("shows the fleet command center (not the home launcher) in fleet mode", () => {
    const keys = navForMode(NAV, "fleet").flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toContain("dashboard");
    expect(keys).toContain("servers");
    expect(keys).not.toContain("home");
  });
});

describe("home mode route guard", () => {
  // Two independent lists must not drift: a nav item shown in Home mode (home: true)
  // whose route isn't allowed by isHomeAllowed() would render a sidebar link that the
  // (app) layout immediately bounces back to /home — a silent dead-end. Guard it.
  it("allows every home-mode nav item's route", () => {
    for (const item of NAV.flatMap((g) => g.items).filter((i) => i.home)) {
      const base = item.href.split("?")[0];
      expect(isHomeAllowed(base), `${item.key} (${base}) is in Home nav but not home-allowed`).toBe(true);
    }
  });
});

describe("command palette destinations", () => {
  it("still exposes Apps and Databases for ⌘K reachability", () => {
    const hrefs = DESTS.map((d) => d.href);
    expect(hrefs).toContain("/apps");
    expect(hrefs).toContain("/databases");
  });

  it("has unique hrefs (no duplicate palette rows) and resolvable i18n labels", () => {
    const hrefs = DESTS.map((d) => d.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const d of DESTS) {
      expect(translate(en, d.labelKey), `${d.labelKey} has no en string`).not.toBe(d.labelKey);
    }
  });
});

describe("notice banner visibility", () => {
  const n = (over: Partial<InstanceUpdateNotice> = {}): InstanceUpdateNotice => ({
    id: "n1",
    message: "m",
    severity: "info",
    url: null,
    ...over,
  });
  it("hidden when there is no notice", () => expect(noticeVisible(null, null)).toBe(false));
  it("shown for a fresh notice", () => expect(noticeVisible(n(), null)).toBe(true));
  it("hidden once dismissed by id", () => expect(noticeVisible(n(), "n1")).toBe(false));
  it("re-shows when the notice id changes", () => expect(noticeVisible(n({ id: "n2" }), "n1")).toBe(true));
  it("critical is non-dismissible (always shown)", () => expect(noticeVisible(n({ severity: "critical" }), "n1")).toBe(true));

  it("every notice severity label resolves in en", () => {
    for (const key of ["noticeInfo", "noticeWarning", "noticeCritical", "noticeDismiss", "noticeLearnMore"]) {
      expect(translate(en, `settings.${key}`), `settings.${key} has no en string`).not.toBe(`settings.${key}`);
    }
  });
});
