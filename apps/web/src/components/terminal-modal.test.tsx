import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";

vi.mock("next/dynamic", () => ({
  default: () => (props: { unavailableReason?: string }) =>
    props.unavailableReason ? <div role="status">{props.unavailableReason}</div> : <div data-testid="term" />,
}));

import { TerminalModal } from "./terminal-modal";

afterEach(cleanup);

describe("TerminalModal", () => {
  it("shows the unavailable reason instead of connecting", () => {
    render(<I18nProvider><TerminalModal target={{ app: "a1" }} title="t" onClose={() => {}} unavailableReason="Deploy the app first." /></I18nProvider>);
    expect(screen.getByText("Deploy the app first.")).toBeTruthy();
    expect(screen.queryByTestId("term")).toBeNull();
  });
  it("connects when no reason is given", () => {
    render(<I18nProvider><TerminalModal target={{ app: "a1" }} title="t" onClose={() => {}} /></I18nProvider>);
    expect(screen.getByTestId("term")).toBeTruthy();
  });
});
