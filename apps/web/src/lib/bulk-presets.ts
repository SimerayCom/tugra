/**
 * One-click fleet maintenance commands for the bulk-run modal. The command is
 * shown in the input and run only on explicit confirm, so these stay reviewable
 * and editable. Mostly read-only diagnostics plus a scoped, rollback-safe Docker
 * cleanup (dangling layers + build cache only — never `docker system prune`, which
 * would strand stopped containers and the retained rollback images; mirrors the
 * per-server "Clean now" script in hub-api cleanup-script.ts).
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
  { key: "cleanup", labelKey: "preset_cleanup", command: "docker image prune -f && docker builder prune -af --filter until=168h" },
];
