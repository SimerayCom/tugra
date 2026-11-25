import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { I18nProvider } from "../../i18n/provider";
import { RunFacts } from "./run-summary";
import { mkRun } from "./test-fixtures";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
afterEach(cleanup);
const mount = (over: Parameters<typeof mkRun>[0]) =>
  render(
    <I18nProvider>
      <RunFacts run={mkRun(over)} />
    </I18nProvider>,
  );

describe("the in-place takeover link on a run", () => {
  it("a same-server (proxy swap) run with an import points at the takeover screen for its server and op", () => {
    mount({ topology: "swap-proxy", opId: "op 9", targetServerId: "srv/1" });
    expect(screen.getByRole("link", { name: "Take over this server in place" }).getAttribute("href")).toBe("/import/inplace?serverId=srv%2F1&opId=op%209");
  });
  it("no link before the import exists, and none for a two-box run", () => {
    mount({ topology: "swap-proxy", opId: null });
    expect(screen.queryByRole("link", { name: "Take over this server in place" })).toBeNull();
    cleanup();
    mount({ topology: "two-box", opId: "op9" });
    expect(screen.queryByRole("link", { name: "Take over this server in place" })).toBeNull();
  });
});
