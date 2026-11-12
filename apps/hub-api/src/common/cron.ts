import { parseExpression } from "cron-parser";

/**
 * True when `expr` is a cron expression BullMQ can actually schedule. The DTOs' shape regex only checks for
 * five whitespace-separated tokens, so out-of-range fields ("0 25 * * *", "60 * * * *") slip through, get
 * persisted, and then throw inside BullMQ's `parseExpression` at schedule time — which, in an unguarded
 * boot loop, crash-loops the hub. Validate with the SAME parser BullMQ uses, so anything we accept schedules.
 */
export function isValidCron(expr: string): boolean {
  if (!expr || !expr.trim()) return false; // cron-parser treats "" as valid; a schedule needs a real expression
  try {
    parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Smallest gap between consecutive fires of `expr`, sampled over the next `samples` occurrences, in ms
 * (null for an unparsable expression). Floors how FREQUENTLY an expensive schedule may run: an interval
 * floor only bounds the plain-hours field, so without this a cron like "* * * * *" bypasses it entirely.
 */
export function minCronGapMs(expr: string, samples = 24, from: Date = new Date()): number | null {
  try {
    const it = parseExpression(expr, { currentDate: from });
    let prev = it.next().toDate().getTime();
    let min = Infinity;
    for (let i = 0; i < samples; i++) {
      const next = it.next().toDate().getTime();
      min = Math.min(min, next - prev);
      prev = next;
    }
    return Number.isFinite(min) ? min : null;
  } catch {
    return null;
  }
}
