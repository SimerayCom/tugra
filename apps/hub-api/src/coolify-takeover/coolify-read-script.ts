import { buildSectionSql, SECTIONS } from "./coolify-sql";

/**
 * "Read this Coolify": a PARAMETERLESS shell script (no value from a request is ever spliced into it) run through the existing
 * `sendCommand` channel with the "database" capability. It only ever talks to the container named `coolify-db`:
 *
 *   docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on ...' coolify-db psql ...
 *
 * psql connects over the container's local socket as the image's own POSTGRES_USER/POSTGRES_DB (read inside the container, never
 * printed), in a read-only session with a statement timeout. The password is never used and APP_KEY is never touched.
 */

export const CFY = {
  noDocker: "TUGRA_CFY_NO_DOCKER",
  noCoolify: "TUGRA_CFY_NO_COOLIFY",
  stopped: "TUGRA_CFY_DB_STOPPED",
  image: "TUGRA_CFY_IMAGE ",
  readOnly: "TUGRA_CFY_RO ",
  begin: "TUGRA_CFY_BEGIN ",
  end: "TUGRA_CFY_END ",
  skip: "TUGRA_CFY_SKIP ",
  done: "TUGRA_CFY_DONE",
} as const;

const PREAMBLE = [
  "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  `command -v docker >/dev/null 2>&1 || { echo ${CFY.noDocker}; exit 0; }`,
  `st=$(docker inspect --format '{{.State.Running}}' coolify-db 2>/dev/null) || { echo ${CFY.noCoolify}; exit 0; }`,
  `[ "$st" = "true" ] || { echo ${CFY.stopped}; exit 0; }`,
  `case "$(docker inspect --format '{{.Config.Image}}' coolify-db 2>/dev/null)" in *postgres*) ;; *) echo ${CFY.noCoolify}; exit 0 ;; esac`,
];

/** Only the checks: is there a running Coolify database container on this host? Reads nothing from it. */
export function buildDetectScript(): string {
  return [...PREAMBLE, `printf '${CFY.image}%s\\n' "$(docker inspect --format '{{.Config.Image}}' coolify 2>/dev/null | head -c 200)"`, `echo ${CFY.done}`].join("\n");
}

/** The whole read: one read-only psql per section, each isolated (a table this Coolify version lacks only skips that section). */
export function buildReadScript(): string {
  const q = [
    "q() {",
    '  n="$1"',
    '  sql=$(cat)',
    '  out=$(printf \'%s\\n\' "$sql" | docker exec -i -e PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=20000 -c idle_in_transaction_session_timeout=20000" coolify-db sh -c \'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"\' 2>/dev/null) || { echo "' +
      CFY.skip +
      '$n"; return 0; }',
    `  echo "${CFY.begin}$n"`,
    '  printf \'%s\\n\' "$out" | head -c 12000000',
    `  echo "${CFY.end}$n"`,
    "}",
  ].join("\n");
  const ro = `printf '${CFY.readOnly}%s\\n' "$(printf '%s\\n' 'show transaction_read_only;' | docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' coolify-db sh -c 'exec psql -X -q -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null | head -c 10)"`;
  const sections = SECTIONS.map((s) => `q ${s.name} <<'TUGRA_CFY_SQL'\n${buildSectionSql(s)}\nTUGRA_CFY_SQL`);
  return [
    ...PREAMBLE,
    `printf '${CFY.image}%s\\n' "$(docker inspect --format '{{.Config.Image}}' coolify 2>/dev/null | head -c 200)"`,
    ro,
    q,
    ...sections,
    `echo ${CFY.done}`,
    "exit 0",
  ].join("\n");
}
