import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import type { AppLink } from "../../../../lib/types";
import { AppLinksMenu } from "./app-links-menu";

afterEach(cleanup);
const wrap = (ui: React.ReactElement) => render(<I18nProvider>{ui}</I18nProvider>);

const LINKS: AppLink[] = [
  { kind: "primary", url: "https://app.example.com", host: "app.example.com", label: null },
  { kind: "alias", url: "https://alias.example.com", host: "alias.example.com", label: null },
  { kind: "service", url: "https://api.example.com", host: "api.example.com", label: "api" },
  { kind: "port", url: "http://203.0.113.7:15432", host: null, label: "db:5432" },
];

describe("AppLinksMenu", () => {
  it("renders nothing for 0 links and for a single link (the header keeps its own anchor)", () => {
    const { container, rerender } = wrap(<AppLinksMenu links={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(<I18nProvider><AppLinksMenu links={[LINKS[0]]} /></I18nProvider>);
    expect(container.innerHTML).toBe("");
  });

  it("shows a counted Links trigger and lists every link in order, each a new-tab anchor", () => {
    wrap(<AppLinksMenu links={LINKS} />);
    fireEvent.click(screen.getByRole("button", { name: /Links \(4\)/ }));
    const items = screen.getAllByRole("menuitem") as HTMLAnchorElement[];
    expect(items.map((a) => a.textContent)).toEqual(["app.example.com", "alias.example.com", "api.example.com", "203.0.113.7:15432"]);
    expect(items.map((a) => a.getAttribute("href"))).toEqual(LINKS.map((l) => l.url));
    for (const a of items) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(items[2].getAttribute("title")).toContain("Service: api");
    expect(items[3].getAttribute("title")).toContain("db:5432");
  });
});
