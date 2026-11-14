import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NAV, DESTS, noticeVisible, noticeMessage, Sidebar, UpdateBadge, nextTheme, resolveTheme } from "./shell";
import type { InstanceUpdateNotice } from "../lib/types";
import { navForMode, isHomeAllowed } from "../lib/ui-mode";
import { translate } from "../i18n/translate";
import { I18nProvider } from "../i18n/provider";
import en from "../i18n/locales/en";

let mockPath = "/servers/abc";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
// Hoisted spies so individual tests (the update badge) can override the signed-in user and the query
// result; the defaults match the rest of the suite (a non-owner fleet user, empty query data).
const mocks = vi.hoisted(() => ({
  useAuth: vi.fn((): { logout: () => void; user: Record<string, unknown> | null } => ({ logout: () => {}, user: { uiMode: "fleet", email: "a@b.c" } })),
  useQuery: vi.fn((): { data: unknown } => ({ data: [] })),
}));
vi.mock("../lib/auth", () => ({ useAuth: mocks.useAuth }));
vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("sidebar active-route semantics", () => {
  const links = () => screen.getAllByRole("link");
  it("marks only the current route's link with aria-current=page and the interaction class", () => {
    mockPath = "/servers/abc";
    render(<Sidebar openPalette={() => {}} />);
    const current = links().filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("href")).toBe("/servers");
    for (const a of links()) expect(a.className).toContain("tg-nav-link");
  });

  it("is also applied in the mobile drawer", () => {
    mockPath = "/projects";
    render(<Sidebar openPalette={() => {}} mobile open />);
    const current = links().filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.getAttribute("href"))).toEqual(["/projects"]);
  });

  it("marks nothing current on an unknown route", () => {
    mockPath = "/nowhere";
    render(<Sidebar openPalette={() => {}} />);
    expect(links().some((a) => a.hasAttribute("aria-current"))).toBe(false);
  });
});

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

  it("strips only the stale self-version (parenthesised version equal to the running one)", () => {
    expect(noticeMessage("You're running the Tugra public beta (0.1.0-beta.2). Report issues on GitHub.", "0.1.0-beta.2")).toBe(
      "You're running the Tugra public beta. Report issues on GitHub.",
    );
    expect(noticeMessage("Public beta (v1.2.3) is live", "1.2.3")).toBe("Public beta is live");
  });
  it("keeps a parenthesised version that differs from the running one (an intended target)", () => {
    expect(noticeMessage("Security fix in (0.1.1), please upgrade", "0.1.0")).toBe("Security fix in (0.1.1), please upgrade");
    expect(noticeMessage("Running (0.1.0) -> upgrade to (0.1.1)", "0.1.0")).toBe("Running -> upgrade to (0.1.1)");
    expect(noticeMessage("Security fix in (0.1.1)", null)).toBe("Security fix in (0.1.1)");
  });
  it("substitutes {version} with the actual running version, or drops it when unknown", () => {
    expect(noticeMessage("Running {version} — thanks!", "0.1.0-beta.3")).toBe("Running 0.1.0-beta.3 — thanks!");
    expect(noticeMessage("Running Tugra {version}.", null)).toBe("Running Tugra.");
  });
  it("leaves a version-agnostic message untouched", () => {
    expect(noticeMessage("Please back up before upgrading.", "0.1.0-beta.3")).toBe("Please back up before upgrading.");
  });

  it("every notice severity label resolves in en", () => {
    for (const key of ["noticeInfo", "noticeWarning", "noticeCritical", "noticeDismiss", "noticeLearnMore"]) {
      expect(translate(en, `settings.${key}`), `settings.${key} has no en string`).not.toBe(`settings.${key}`);
    }
  });
});

describe("grouped, collapsible sidebar nav", () => {
  const GROUPS = {
    monitor: ["home", "dashboard", "fleet", "traffic", "uptime"],
    build: ["projects", "appStore", "import", "sources", "registries"],
    infrastructure: ["servers", "clusters", "rollouts", "terminal", "destinations", "domains"],
    integrations: ["cloudCredentials", "secretProviders", "sharedVars"],
    account: ["notifications", "audit", "teams", "settings"],
  };
  const renderSb = () => render(<I18nProvider><Sidebar openPalette={() => {}} /></I18nProvider>);
  const header = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}$`, "i") });

  it("splits Resources into Build / Infrastructure / Integrations with stable i18n keys", () => {
    expect(NAV.map((g) => g.group)).toEqual(Object.keys(GROUPS));
    for (const g of NAV) expect(g.items.map((i) => i.key)).toEqual(GROUPS[g.group as keyof typeof GROUPS]);
    for (const g of NAV) expect(translate(en, `nav.group.${g.group}`)).not.toBe(`nav.group.${g.group}`);
  });

  it("keeps every item reachable via DESTS", () => {
    const hrefs = DESTS.map((d) => d.href);
    for (const it of NAV.flatMap((g) => g.items)) expect(hrefs).toContain(it.href);
  });

  it("renders a translated header button per fleet-mode group, expanded by default", () => {
    mockPath = "/servers/abc";
    renderSb();
    for (const label of ["Build", "Infrastructure", "Integrations", "Account"]) {
      expect(header(label).getAttribute("aria-expanded")).toBe("true");
    }
    // Monitor's only fleet items are dashboard/fleet/uptime (home is home-only), so the header still shows.
    expect(header("Monitor")).toBeTruthy();
    expect(screen.queryByText("Resources")).toBeNull();
  });

  it("collapses and expands a group, hiding its items, and persists per group", () => {
    mockPath = "/nowhere";
    renderSb();
    const hrefs = () => screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs()).toContain("/clusters");

    fireEvent.click(header("Infrastructure"));
    expect(header("Infrastructure").getAttribute("aria-expanded")).toBe("false");
    expect(hrefs()).not.toContain("/clusters");
    expect(hrefs()).not.toContain("/servers");
    expect(hrefs()).toContain("/projects"); // other groups untouched
    expect(localStorage.getItem("tugra.navgroup.infrastructure")).toBe("1");
    expect(localStorage.getItem("tugra.navgroup.build")).toBeNull();

    fireEvent.click(header("Infrastructure"));
    expect(header("Infrastructure").getAttribute("aria-expanded")).toBe("true");
    expect(hrefs()).toContain("/clusters");
    expect(localStorage.getItem("tugra.navgroup.infrastructure")).toBe("0");
  });

  it("hydrates a persisted collapsed group on mount", () => {
    localStorage.setItem("tugra.navgroup.integrations", "1");
    mockPath = "/nowhere";
    renderSb();
    expect(header("Integrations").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).not.toContain("/secret-providers");
    expect(header("Build").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps aria-current on the active route and keeps it findable when another group is collapsed", () => {
    mockPath = "/clusters";
    renderSb();
    fireEvent.click(header("Build"));
    const current = screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.getAttribute("href"))).toEqual(["/clusters"]);
  });

  it("icon-collapsed mode hides headers and ignores per-group collapse (all items shown)", () => {
    localStorage.setItem("tugra.sidebar", "1");
    localStorage.setItem("tugra.navgroup.build", "1");
    mockPath = "/nowhere";
    renderSb();
    expect(screen.queryByRole("button", { name: /^Build$/i })).toBeNull();
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toContain("/projects");
  });
});

describe("top-bar update badge", () => {
  const owner = (over = {}) => ({ logout: vi.fn(), user: { uiMode: "fleet", email: "a@b.c", isInstanceOwner: true, ...over } });
  afterEach(() => {
    // restore the suite-wide defaults so later files/tests see a non-owner with empty query data
    mocks.useAuth.mockReturnValue({ logout: vi.fn(), user: { uiMode: "fleet", email: "a@b.c" } });
    mocks.useQuery.mockReturnValue({ data: [] });
  });

  it("links an owner straight to the Updates card when an update is available", () => {
    mocks.useAuth.mockReturnValue(owner());
    mocks.useQuery.mockReturnValue({ data: { updateAvailable: true, latest: "0.1.0-beta.7" } });
    render(<I18nProvider><UpdateBadge /></I18nProvider>);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/settings?tab=instance&section=backups#updates");
    expect(link.textContent).toContain("0.1.0-beta.7");
  });

  it("renders nothing for a non-owner even when an update is available", () => {
    mocks.useAuth.mockReturnValue({ logout: vi.fn(), user: { uiMode: "fleet", email: "a@b.c" } });
    mocks.useQuery.mockReturnValue({ data: { updateAvailable: true, latest: "0.1.0-beta.7" } });
    const { container } = render(<I18nProvider><UpdateBadge /></I18nProvider>);
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders nothing for an owner who is already up to date", () => {
    mocks.useAuth.mockReturnValue(owner());
    mocks.useQuery.mockReturnValue({ data: { updateAvailable: false, latest: "0.1.0-beta.6" } });
    const { container } = render(<I18nProvider><UpdateBadge /></I18nProvider>);
    expect(container.querySelector("a")).toBeNull();
  });

  it("hides its text (icon only) in compact mode but keeps the link and aria-label", () => {
    mocks.useAuth.mockReturnValue(owner());
    mocks.useQuery.mockReturnValue({ data: { updateAvailable: true, latest: "0.1.0-beta.7" } });
    render(<I18nProvider><UpdateBadge compact /></I18nProvider>);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/settings?tab=instance&section=backups#updates");
    expect(link.textContent).not.toContain("0.1.0-beta.7"); // version hidden in the compact pill
    expect(link.getAttribute("aria-label")).toContain("0.1.0-beta.7"); // still announced
  });
});

describe("tri-state theme", () => {
  it("cycles System → Light → Dark → System", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  it("resolves 'system' from the OS preference and passes light/dark through", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light"); // explicit choice ignores the OS
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
