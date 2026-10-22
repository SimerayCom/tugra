/**
 * Sanitize an MCP tool result before it is handed to a third-party AI client (Claude Desktop, ChatGPT,
 * an IDE …) as conversation context, with a Tugra-specific secret field-name set. This is defense-in-depth:
 * the tool catalog is curated to never return decrypted secret values in the first place (env is key-names
 * only, no presigned-URL tools), but the MCP layer bypasses the per-controller RedactSecretsInterceptor, so
 * we redact here too.
 *
 * - Named secret fields are nulled (never leak a secret value / credential-bearing URL into LLM context).
 * - Strings have code fences neutralized (a tool result must not be able to open an instruction block —
 *   prompt-injection defense) and are truncated.
 * - A depth guard prevents a pathological/circular structure from blowing the stack.
 */

// Targeted secret / credential-bearing field names (NOT generic ones like `value`/`key`/`token`, which
// would over-redact legitimate metric/label fields). Aligned with the fields the REST layer redacts via
// RedactSecretsInterceptor plus credential-bearing URL fields reserved for later phases.
const SECRET_FIELD_NAMES = new Set([
  "webhookSecret",
  "dnsCredsEnc",
  "credsEnc",
  "dnsCredsB64",
  "sshPrivateKey",
  "privateKey",
  "password",
  "dbPassword",
  "registryPassword",
  "tokenHash",
  "encryptedValue",
  "envValue",
  // credential-bearing URLs (presigned S3 / migration export) — reserved for later phases, redacted now
  "exportUrl",
  "presignedUrl",
  "downloadUrl",
  "shareUrl",
  "migrationUrl",
  // a managed DB's connection string embeds its password; username is the other half. The DatabaseView
  // exposes both to a writer, and the MCP read path bypasses the REST RedactSecretsInterceptor, so a
  // read-SCOPED PAT (still owned by a writer) would otherwise read the DB password out of connectionUri.
  "connectionUri",
  "username",
  // app config that carries inline secrets / grants write-equivalent power, and must not reach a
  // read-scoped MCP client: the raw compose file (may embed env/secrets), docker run options (can
  // mount host paths / inject env), and the deploy webhook token.
  "composeFile",
  "dockerOptions",
  "webhookToken",
]);

const MAX_STRING_LEN = 2000;
const MAX_DEPTH = 8;

function sanitizeString(s: string): string {
  // Turn ``` into ''' so a tool result can't open a markdown/instruction fence in the model's context.
  let out = s.split("```").join("'''");
  if (out.length > MAX_STRING_LEN) out = out.slice(0, MAX_STRING_LEN) + "…";
  return out;
}

export function sanitizeToolResult(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return sanitizeString(input);
  if (Array.isArray(input)) return input.map((i) => sanitizeToolResult(i, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_FIELD_NAMES.has(k)) {
        out[k] = null; // drop the secret value, keep the key so the shape is still legible
        continue;
      }
      out[k] = sanitizeToolResult(v, depth + 1);
    }
    return out;
  }
  return input; // number / boolean / bigint passthrough
}
