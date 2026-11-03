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
