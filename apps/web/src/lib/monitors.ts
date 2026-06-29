import type { Heartbeat, MonitorStatus } from "./types";

/** Up/down/total counts across a heartbeat window (drives the screen-reader summary). */
export function heartbeatSummary(beats: Heartbeat[]): { up: number; down: number; total: number } {
  const up = beats.filter((b) => b.status === "UP").length;
  const down = beats.filter((b) => b.status === "DOWN").length;
  return { up, down, total: beats.length };
}

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
