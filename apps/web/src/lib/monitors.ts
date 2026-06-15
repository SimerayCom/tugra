import type { MonitorStatus } from "./types";

export function monitorColor(status: MonitorStatus): string {
  if (status === "UP") return "var(--c-g)";
  if (status === "DOWN") return "var(--c-r)";
  return "var(--c-am)";
}

export function uptimeText(percent: number): string {
  return `${percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

/** Config fields each channel type needs (drives the add-channel form). */
export const CHANNEL_FIELDS: Record<string, string[]> = {
  webhook: ["url"],
  discord: ["webhookUrl"],
  slack: ["webhookUrl"],
  telegram: ["botToken", "chatId"],
  ntfy: ["topic", "server"],
};
