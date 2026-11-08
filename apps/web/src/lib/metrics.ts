const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];

/**
 * Scale a byte/s series into a single readable unit and return the scaled data
 * plus the unit label (e.g. "KB/s"). The unit is chosen from the most recent
 * (last) value — the current throughput the chart prints — not the series peak:
 * the chart has no Y-axis, so the unit only labels the current-value readout, and
 * a past spike must not force e.g. "MB/s" and make a now-quiet link read
 * "0.0 MB/s" while real traffic flows. An empty or currently-idle series stays in
 * "B/s" with its values untouched.
 */
export function humanizeRateSeries(values: number[]): { data: number[]; unit: string } {
  const current = values.length ? values[values.length - 1] : 0;
  const { unit, divisor } = pickRateUnit(current);
  return { data: scaleBy(values, divisor), unit };
}

/**
 * Two paired byte/s series (net in/out, disk read/write) scaled into ONE shared unit so they can overlay in a
 * single chart. The unit follows the larger of the two current (last) values, same rule as the single-series form.
 */
export function humanizeRatePair(a: number[], b: number[]): { a: number[]; b: number[]; unit: string } {
  const last = (v: number[]) => (v.length ? v[v.length - 1] : 0);
  const { unit, divisor } = pickRateUnit(Math.max(last(a), last(b)));
  return { a: scaleBy(a, divisor), b: scaleBy(b, divisor), unit };
}

function pickRateUnit(current: number): { unit: string; divisor: number } {
  let i = 0;
  let m = current;
  while (m >= 1024 && i < RATE_UNITS.length - 1) {
    m /= 1024;
    i++;
  }
  return { unit: RATE_UNITS[i], divisor: 1024 ** i };
}

const scaleBy = (values: number[], divisor: number) => (divisor === 1 ? values.slice() : values.map((v) => v / divisor));

/** Disk-usage % history from the used/total pair every host sample (raw row or rollup bucket) already
 *  carries. Samples with no usable total (0 / missing / non-finite) are skipped, and `times` stays aligned
 *  with `data` so the chart's time axis is correct. */
export function diskPctSeries(
  samples: { ts: number; diskUsed: number; diskTotal: number }[],
): { times: number[]; data: number[] } {
  const times: number[] = [];
  const data: number[] = [];
  for (const s of samples) {
    if (Number.isFinite(s.diskUsed) && Number.isFinite(s.diskTotal) && s.diskTotal > 0 && Number.isFinite(s.ts)) {
      times.push(s.ts);
      data.push(Math.min(Math.max((s.diskUsed / s.diskTotal) * 100, 0), 100));
    }
  }
  return { times, data };
}
