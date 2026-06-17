/**
 * Pure builder for the server-wide Docker cleanup command. `docker system prune`
 * only removes dangling/unused resources (running containers + their images are
 * untouched). `--volumes` also drops unused volumes — destructive, opt-in.
 */
export function buildCleanupScript({ volumes }: { volumes: boolean }): string {
  return `docker system prune -af${volumes ? " --volumes" : ""}`;
}
