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
  let i = 0;
  let m = current;
  while (m >= 1024 && i < RATE_UNITS.length - 1) {
    m /= 1024;
    i++;
  }
  const divisor = 1024 ** i;
  return {
    data: divisor === 1 ? values.slice() : values.map((v) => v / divisor),
    unit: RATE_UNITS[i],
  };
}
