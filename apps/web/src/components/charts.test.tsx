import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MetricChart } from "./charts";

afterEach(cleanup);

describe("MetricChart", () => {
  it("renders the last value without crashing", () => {
    render(<MetricChart data={[1, 2, 3.456]} label="CPU" unit="%" decimals={1} />);
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("3.5%")).toBeTruthy();
  });

  it("tolerates a non-finite series (undefined/NaN) without throwing — coerces to 0", () => {
    // An older agent omits a newer metric field → its live sample reaches the chart as undefined.
    const dirty = [1, NaN, undefined as unknown as number];
    expect(() => render(<MetricChart data={dirty} label="Disk" unit=" MB/s" decimals={1} />)).not.toThrow();
    expect(screen.getByText("0.0 MB/s")).toBeTruthy(); // last coerced to 0, not "NaN"/crash
  });

  it("renders an empty series as 0", () => {
    render(<MetricChart data={[]} label="Net" unit="%" />);
    expect(screen.getByText("0%")).toBeTruthy();
  });
});
