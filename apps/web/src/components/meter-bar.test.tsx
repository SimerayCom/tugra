import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MeterBar } from "./meter-bar";

afterEach(cleanup);

describe("MeterBar", () => {
  it("renders a progressbar with the value and a proportional fill", () => {
    render(<MeterBar value={63} tone="ok" text="63%" label="CPU" />);
    const bar = screen.getByRole("progressbar", { name: "CPU" });
    expect(bar.getAttribute("aria-valuenow")).toBe("63");
    expect(screen.getByText("63%")).toBeTruthy();
    expect((bar.querySelector("div") as HTMLElement | null)?.style.width).toBe("63%");
  });

  it("null value → dash text, no fill element, no aria-valuenow", () => {
    render(<MeterBar value={null} text="—" label="GPU" />);
    const bar = screen.getByRole("progressbar", { name: "GPU" });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.querySelector("div")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("clamps out-of-range values to 0..100", () => {
    const { rerender } = render(<MeterBar value={150} text="x" label="a" />);
    expect((screen.getByRole("progressbar").querySelector("div") as HTMLElement).style.width).toBe("100%");
    rerender(<MeterBar value={-5} text="x" label="a" />);
    expect((screen.getByRole("progressbar").querySelector("div") as HTMLElement).style.width).toBe("0%");
  });
});
