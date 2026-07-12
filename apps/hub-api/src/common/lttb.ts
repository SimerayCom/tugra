// Largest-Triangle-Three-Buckets downsampling — reduces a time series to at most `threshold` points
// while preserving its visual shape (peaks/troughs), the way Coolify does for long-range metric
// charts. `y` extracts the value axis to compare on; the x axis is the array index (samples are
// evenly ordered in time). Multi-field samples: the selection is driven by `y` and the WHOLE sample
// at each chosen index is kept, so every field stays aligned on the same points.
export function downsampleLTTB<T>(points: T[], threshold: number, y: (p: T) => number): T[] {
  const n = points.length;
  if (threshold >= n || threshold < 3) return points; // nothing to do / degenerate

  const sampled: T[] = [points[0]]; // always keep the first point
  const bucketSize = (n - 2) / (threshold - 2); // buckets over the middle points
  let a = 0; // index of the last selected point

  for (let i = 0; i < threshold - 2; i++) {
    // average x/y of the NEXT bucket (the "third" point of the triangle)
    let avgX = 0;
    let avgY = 0;
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    let rangeEnd = Math.floor((i + 2) * bucketSize) + 1;
    rangeEnd = rangeEnd < n ? rangeEnd : n;
    const avgCount = rangeEnd - rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      avgX += j;
      avgY += y(points[j]);
    }
    avgX /= avgCount;
    avgY /= avgCount;

    // pick the point in THIS bucket forming the largest triangle with a + the next-bucket average
    const bucketStart = Math.floor(i * bucketSize) + 1;
    const bucketEnd = Math.floor((i + 1) * bucketSize) + 1;
    const ax = a;
    const ay = y(points[a]);
    let maxArea = -1;
    let chosen = bucketStart;
    for (let j = bucketStart; j < bucketEnd; j++) {
      const area = Math.abs((ax - avgX) * (y(points[j]) - ay) - (ax - j) * (avgY - ay));
      if (area > maxArea) {
        maxArea = area;
        chosen = j;
      }
    }
    sampled.push(points[chosen]);
    a = chosen;
  }

  sampled.push(points[n - 1]); // always keep the last point
  return sampled;
}
