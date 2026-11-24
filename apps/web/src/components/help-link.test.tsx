import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../i18n/provider";
import { HelpLink, MoreInfo } from "./help-link";
import { ServerAccessHelp } from "./server-access-help";
import { GUIDE_IDS } from "../lib/help-links";
import common from "../i18n/locales/en/common.json";

afterEach(cleanup);
const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe("HelpLink", () => {
  it("is a labelled link to the guide on tugra.io/docs that opens in a new tab", () => {
    wrap(<HelpLink guide="add-a-server" />);
    const a = screen.getByRole("link", { name: "Guide: Add a server" });
    expect(a.getAttribute("href")).toBe("https://tugra.io/docs/add-a-server");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.textContent).toBe("?");
  });
  it("every guide has a label in the locale", () => {
    for (const id of GUIDE_IDS) expect(typeof (common.help.guide as Record<string, string>)[id], id).toBe("string");
  });
});

describe("MoreInfo", () => {
  it("is closed by default and keeps its content in a native disclosure", () => {
    wrap(<MoreInfo>detail text</MoreInfo>);
    const d = screen.getByText("More").closest("details") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(within(d).getByText("detail text")).toBeTruthy();
  });
  it("takes a custom label", () => {
    wrap(<MoreInfo label="Advanced">x</MoreInfo>);
    expect(screen.getByText("Advanced")).toBeTruthy();
  });
});

describe("ServerAccessHelp", () => {
  it("lists the four ways to run the command, one line each, behind a closed disclosure, with the guide link", () => {
    wrap(<ServerAccessHelp />);
    const d = screen.getByText("Can't reach the server?").closest("details") as HTMLDetailsElement;
    expect(d.open).toBe(false);
    const items = within(screen.getByTestId("server-access-help")).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toMatch(/SSH/);
    expect(items[1].textContent).toMatch(/Tailscale/);
    expect(items[2].textContent).toMatch(/Reset root password/);
    expect(items[3].textContent).toMatch(/cloud-init/);
    expect(screen.getByRole("link", { name: "Open the guide" }).getAttribute("href")).toBe("https://tugra.io/docs/add-a-server");
  });
});
