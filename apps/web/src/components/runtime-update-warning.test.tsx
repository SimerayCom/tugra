import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { I18nProvider } from "../i18n/provider";
import { RuntimeUpdateWarning } from "./runtime-update-warning";

afterEach(cleanup);
const wrap = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

describe("RuntimeUpdateWarning", () => {
  it("warns that applying the update restarts every app and names the packages", () => {
    wrap(<RuntimeUpdateWarning packages={["docker-ce", "containerd.io"]} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/every app and database on this server restarts/i);
    expect(alert.textContent).toContain("docker-ce, containerd.io");
  });
  it("renders nothing without a runtime package", () => {
    const { container } = wrap(<RuntimeUpdateWarning packages={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
