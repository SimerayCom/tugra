import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { I18nProvider } from "../../i18n/provider";
import { api } from "../../lib/api";
import { ScheduleField, scheduleFromFields, scheduleToFields, scheduleComplete, type ScheduleValue } from "./schedule-field";

function Harness({ initial, minGapHours, onValue }: { initial: ScheduleValue; minGapHours?: number; onValue?: (v: ScheduleValue) => void }) {
  const [v, setV] = useState(initial);
  return <ScheduleField value={v} minGapHours={minGapHours} onChange={(n) => { setV(n); onValue?.(n); }} />;
}
const show = (initial: ScheduleValue, minGapHours?: number, onValue?: (v: ScheduleValue) => void) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <Harness initial={initial} minGapHours={minGapHours} onValue={onValue} />
      </I18nProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.spyOn(api, "previewSchedule").mockResolvedValue({ valid: true, timezone: "Europe/Istanbul", nextRuns: ["2026-11-16T03:00:00Z", "2026-11-17T03:00:00Z", "2026-11-18T03:00:00Z"], minGapSeconds: 86400 });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); });

describe("schedule value helpers", () => {
  it("a stored cron wins; the inactive mode sends null for its field", () => {
    expect(scheduleFromFields(24, "0 3 * * *")).toEqual({ mode: "cron", hours: "24", cron: "0 3 * * *" });
    expect(scheduleFromFields(6, null)).toEqual({ mode: "interval", hours: "6", cron: "" });
    expect(scheduleToFields({ mode: "cron", hours: "6", cron: " 0 3 * * * " })).toEqual({ intervalHours: null, cron: "0 3 * * *" });
    expect(scheduleToFields({ mode: "interval", hours: "6", cron: "0 3 * * *" })).toEqual({ intervalHours: 6, cron: null });
    expect(scheduleComplete({ mode: "cron", hours: "6", cron: "  " })).toBe(false);
    expect(scheduleComplete({ mode: "interval", hours: "6", cron: "" })).toBe(true);
  });
});

describe("ScheduleField", () => {
  it("interval mode shows the hours input and never calls the preview", async () => {
    show({ mode: "interval", hours: "12", cron: "" });
    expect((screen.getByLabelText("Every (hours)") as HTMLInputElement).value).toBe("12");
    await new Promise((r) => setTimeout(r, 350));
    expect(api.previewSchedule).not.toHaveBeenCalled();
  });

  it("preset chips map to their crons (hourly/daily/weekly/monthly)", () => {
    const seen: string[] = [];
    show({ mode: "cron", hours: "24", cron: "0 3 * * *" }, undefined, (v) => seen.push(v.cron));
    fireEvent.click(screen.getByRole("button", { name: "Hourly" }));
    fireEvent.click(screen.getByRole("button", { name: "Weekly (Sun 03:00)" }));
    fireEvent.click(screen.getByRole("button", { name: "Monthly (1st 03:00)" }));
    fireEvent.click(screen.getByRole("button", { name: "Daily 03:00" }));
    expect(seen).toEqual(["0 * * * *", "0 3 * * 0", "0 3 1 * *", "0 3 * * *"]);
    expect(screen.getByRole("button", { name: "Daily 03:00" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("switching to cron seeds the daily preset", () => {
    let last: ScheduleValue | undefined;
    show({ mode: "interval", hours: "24", cron: "" }, undefined, (v) => (last = v));
    fireEvent.click(screen.getByLabelText("Cron expression"));
    expect(last).toMatchObject({ mode: "cron", cron: "0 3 * * *" });
  });

  it("debounces the preview (one call for a burst of typing) and labels the hub timezone", async () => {
    show({ mode: "cron", hours: "24", cron: "" });
    const input = screen.getByLabelText("Cron (5 fields)");
    fireEvent.change(input, { target: { value: "0 4" } });
    fireEvent.change(input, { target: { value: "0 4 * * *" } });
    expect(api.previewSchedule).not.toHaveBeenCalled();
    expect(await screen.findByText("Next runs")).toBeTruthy();
    expect(api.previewSchedule).toHaveBeenCalledTimes(1);
    expect(api.previewSchedule).toHaveBeenCalledWith("0 4 * * *", 3);
    expect(screen.getByText(/Europe\/Istanbul/)).toBeTruthy();
    expect(document.querySelectorAll("li")).toHaveLength(3);
  });

  it("shows the inline error for an invalid cron", async () => {
    (api.previewSchedule as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: false, error: "bad", timezone: "UTC", nextRuns: [], minGapSeconds: null });
    show({ mode: "cron", hours: "24", cron: "nope" });
    expect(await screen.findByText("Not a valid cron expression.")).toBeTruthy();
    expect(screen.queryByText("Next runs")).toBeNull();
  });

  it("warns when the cron can fire more often than the resource allows", async () => {
    (api.previewSchedule as ReturnType<typeof vi.fn>).mockResolvedValue({ valid: true, timezone: "UTC", nextRuns: ["2026-11-16T03:00:00Z"], minGapSeconds: 900 });
    show({ mode: "cron", hours: "24", cron: "*/15 * * * *" }, 1);
    await waitFor(() => expect(screen.getByText(/more often than once an hour/)).toBeTruthy());
  });
});
