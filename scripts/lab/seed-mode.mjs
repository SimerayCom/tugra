// The engine and data lane a lab import op seeds (kept apart from seed.mjs, which runs main() on load, so selftest.mjs can import it).
// resolveDbMode(kind, engine, dataMode) -> { engine, mode }: the engine and data lane an op seeds. An app op has no engine.
// PostgreSQL defaults to the physical copy (the lab's historical behaviour); every other engine is logical only.
export function resolveDbMode(kind, engine, dataMode) {
  if (kind !== "db") return { engine: "POSTGRES", mode: "volume" };
  if (!["POSTGRES", "MARIADB", "MYSQL", "REDIS"].includes(engine)) throw new Error(`bad --engine ${engine}`);
  const mode = dataMode || (engine === "POSTGRES" ? "volume" : "dump");
  if (mode !== "volume" && mode !== "dump") throw new Error(`bad --data-mode ${mode}`);
  if (mode === "volume" && engine !== "POSTGRES") throw new Error(`--data-mode volume is PostgreSQL only (got ${engine})`);
  return { engine, mode };
}
