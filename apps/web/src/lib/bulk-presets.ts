/**
 * One-click fleet maintenance commands for the bulk-run modal. The command is
 * shown in the input and run only on explicit confirm, so these stay reviewable
 * and editable. Mostly read-only diagnostics plus a standard Docker cleanup.
 */
export interface BulkPreset {
  key: string;
  labelKey: string; // i18n key under "bulk"
  command: string;
}

export const BULK_PRESETS: BulkPreset[] = [
  { key: "uptime", labelKey: "preset_uptime", command: "uptime" },
  { key: "disk", labelKey: "preset_disk", command: "df -h" },
  { key: "memory", labelKey: "preset_memory", command: "free -h" },
  { key: "docker", labelKey: "preset_docker", command: "docker ps -a --format 'table {{.Names}}\\t{{.Status}}'" },
  { key: "cleanup", labelKey: "preset_cleanup", command: "docker system prune -af" },
];
