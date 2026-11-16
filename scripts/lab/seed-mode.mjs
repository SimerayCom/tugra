// The engine and data lane a lab import op seeds (kept apart from seed.mjs, which runs main() on load, so selftest.mjs can import it).
// resolveDbMode(kind, engine, dataMode) -> { engine, mode }: the engine and data lane an op seeds. An app op has no engine.
// PostgreSQL defaults to the physical copy (the lab's historical behaviour); every other engine is logical only.
// `stream` is the streamed dump lane (the owner's largeDbMode "stream-logical"): the database is put on the lane through
// `BulkOperation.meta.vxStream`, exactly what the guided run's DATA_SEED writes, and its migrator row is `volume:_:<ref>:dump`.
export const STREAM_ENGINES = ["POSTGRES", "MARIADB", "MYSQL"];
export function resolveDbMode(kind, engine, dataMode) {
  if (kind !== "db") return { engine: "POSTGRES", mode: "volume" };
  if (!["POSTGRES", "MARIADB", "MYSQL", "REDIS"].includes(engine)) throw new Error(`bad --engine ${engine}`);
  const mode = dataMode || (engine === "POSTGRES" ? "volume" : "dump");
  if (mode !== "volume" && mode !== "dump" && mode !== "stream") throw new Error(`bad --data-mode ${mode}`);
  if (mode === "volume" && engine !== "POSTGRES") throw new Error(`--data-mode volume is PostgreSQL only (got ${engine})`);
  if (mode === "stream" && !STREAM_ENGINES.includes(engine)) throw new Error(`--data-mode stream is for PostgreSQL, MariaDB and MySQL (got ${engine})`);
  return { engine, mode };
}

// The migrator row a seeded op reports: the database ref for the artifact route, the volume ref for a physical copy, `<ref>:dump` for
// the streamed lane. `kind` and `ownerRef` are the op's own; `source` and `volume` the source container and the declared volume.
export function itemRefFor(plan, kind, source, volume) {
  if (plan.mode === "dump") return `database:_:${source}`;
  if (plan.mode === "stream") return `volume:_:${source}:dump`;
  return `volume:_:${source}:${kind === "db" ? "data" : volume}`;
}

// `meta` of an op with `ownerRef` put on the streamed lane (what DATA_SEED's setStreamMode writes): a new object, `meta` untouched.
export function withStreamMode(meta, ownerRef, on, userId, at) {
  const base = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
  const cur = base.vxStream && typeof base.vxStream === "object" && !Array.isArray(base.vxStream) ? { ...base.vxStream } : {};
  if (on) cur[ownerRef] = { at, by: userId };
  else delete cur[ownerRef];
  return { ...base, vxStream: cur };
}
