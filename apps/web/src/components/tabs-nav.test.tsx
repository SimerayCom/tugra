import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Tabs } from "./tabs-nav";
import { StatusPill } from "./ui";

afterEach(cleanup);

describe("Tabs", () => {
  it("renders tabs and reports clicks", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        active="a"
        onChange={onChange}
        tabs={[
          { key: "a", label: "Overview" },
          { key: "b", label: "Logs", badge: 3 },
        ]}
      />,
    );
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy(); // badge
    fireEvent.click(screen.getByText("Logs"));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("StatusPill", () => {
  it("renders the status label", () => {
    render(<StatusPill label="RUNNING" color="#2fbf71" />);
    expect(screen.getByText("RUNNING")).toBeTruthy();
  });
});
