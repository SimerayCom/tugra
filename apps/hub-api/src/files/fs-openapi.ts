import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";

const DESCRIPTIONS: Record<number, string> = {
  408: "The upload was too slow (below the minimum throughput or past its deadline) and was cancelled: `upload_too_slow`.",
  409: "Refused: `exists`, `not_dir`, `is_dir`, `not_regular`, `not_empty`, `read_only`, `no_binary`, `not_running`, `not_configured`, `deploy_in_progress`, `datastore_running` or `agent_too_old`.",
  411: "`Content-Length` is required on an upload.",
  412: "The file changed since the supplied `ifMatch` etag (or while it was being read): `changed`.",
  413: "Over the size limit (`FILES_MAX_UPLOAD_BYTES` / `FILES_MAX_DOWNLOAD_BYTES`): `too_large`.",
  429: "`rate_limited` (see `Retry-After`; mutations are limited per user) or `busy` (too many file operations or uploads in flight; retry shortly).",
  502: "The agent failed the operation (`failed`, `integrity`) or answered with an unknown code (`agent_error`).",
  503: "The server's agent is offline.",
  504: "The agent did not answer in time (`expired`) or the operation timed out.",
  507: "The hub's upload staging is full or out of disk (`staging_full`) or the volume is out of space (`no_space`).",
};

/** Document the typed error statuses a file route can return: each references the shared `FsErrorBody` component (registered in openapi.ts). */
export function ApiFileErrors(...statuses: number[]) {
  return applyDecorators(...statuses.map((status) => ApiResponse({ status, description: DESCRIPTIONS[status], schema: { $ref: "#/components/schemas/FsErrorBody" } })));
}
