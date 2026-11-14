import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../../../i18n/provider";
import type { Application, AppLink } from "../../../../lib/types";
import { AppOverview } from "./app-detail-misc-cards";

afterEach(cleanup);

const app = (links: AppLink[], url: string | null) =>
  ({ id: "a1", status: "RUNNING", source: "COMPOSE", exposeMode: "custom", clusterId: null, replicas: null, containerPort: null, memoryMb: null, cpus: null, canWrite: true, url, links }) as unknown as Application;
const show = (a: Application) => render(<I18nProvider><AppOverview app={a} deployments={[]} /></I18nProvider>);

describe("AppOverview — Live URL row", () => {
  it("lists every link as a new-tab anchor, primary first, and labels the non-primary kinds", () => {
    show(
      app(
        [
          { kind: "primary", url: "https://app.example.com", host: "app.example.com", label: null },
          { kind: "service", url: "https://api.example.com", host: "api.example.com", label: "api" },
        ],
        "https://app.example.com",
      ),
    );
    const anchors = screen.getAllByRole("link") as HTMLAnchorElement[];
    expect(anchors.map((a) => a.getAttribute("href"))).toEqual(["https://app.example.com", "https://api.example.com"]);
    for (const a of anchors) expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByText("Service: api")).toBeTruthy();
  });

  it("says the app is not exposed when there are no links", () => {
    show(app([], null));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
