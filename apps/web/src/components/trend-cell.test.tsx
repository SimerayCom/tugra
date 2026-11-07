import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TrendCell } from "./trend-cell";
import type { FleetTrendRow } from "../lib/types";

afterEach(cleanup);

describe("TrendCell (sparkline wiring for the server + fleet tables)", () => {
  it("draws a CPU and a RAM sparkline from the batch trend row, with accessible names", () => {
    const row: FleetTrendRow = { serverId: "a", points: [{ ts: 1, cpu: 10, mem: 40 }, { ts: 2, cpu: 30, mem: 45 }, { ts: 3, cpu: 20, mem: 50 }] };
    const { container } = render(<TrendCell row={row} cpuLabel="CPU trend" memLabel="RAM trend" />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
    expect(screen.getByRole("img", { name: "CPU trend" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "RAM trend" })).toBeTruthy();
  });

  it("a server with no recent series shows em-dash placeholders instead of crashing or an empty box", () => {
    render(<TrendCell row={undefined} cpuLabel="c" memLabel="m" />);
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("a single point can't draw a line → placeholder", () => {
    render(<TrendCell row={{ serverId: "a", points: [{ ts: 1, cpu: 5, mem: 5 }] }} cpuLabel="c" memLabel="m" />);
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
