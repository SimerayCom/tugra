import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A named connection: a hub URL + the personal access token to authenticate against it. */
export interface Profile {
  hub: string;
  token: string;
}

/** The CLI config file — multiple named profiles + which one is active. */
export interface CliConfig {
  current: string | null;
  profiles: Record<string, Profile>;
}

/** ~/.config/tugra (honouring $XDG_CONFIG_HOME). */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "tugra");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/** Read the config, or a FRESH empty one if it doesn't exist / is unreadable. Never throws. Always returns
 *  a brand-new object graph so a caller mutating `.profiles` can't pollute a shared default. */
export function loadConfig(): CliConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      current: typeof parsed.current === "string" ? parsed.current : null,
      profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {},
    };
  } catch {
    return { current: null, profiles: {} };
  }
}

/** Write the config with owner-only permissions — it holds bearer tokens. */
export function saveConfig(cfg: CliConfig): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configPath();
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's `mode` only applies when creating the file; force 0600 on an existing (possibly looser) one.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* chmod is a no-op on some platforms (e.g. Windows) — ignore. */
  }
}

/** The active profile + its name, or null if none is set. */
export function getActiveProfile(cfg: CliConfig = loadConfig()): { name: string; profile: Profile } | null {
  if (!cfg.current) return null;
  const profile = cfg.profiles[cfg.current];
  return profile ? { name: cfg.current, profile } : null;
}

/** Upsert a profile and make it the active one. */
export function setProfile(name: string, profile: Profile): void {
  const cfg = loadConfig();
  cfg.profiles[name] = profile;
  cfg.current = name;
  saveConfig(cfg);
}

/** Remove a profile; if it was active, clear the active pointer. Returns whether it existed. */
export function removeProfile(name: string): boolean {
  const cfg = loadConfig();
  if (!(name in cfg.profiles)) return false;
  delete cfg.profiles[name];
  if (cfg.current === name) cfg.current = null;
  saveConfig(cfg);
  return true;
}

/** Switch the active profile. Throws if it doesn't exist. */
export function setCurrent(name: string): void {
  const cfg = loadConfig();
  if (!(name in cfg.profiles)) throw new Error(`no such profile: ${name}`);
  cfg.current = name;
  saveConfig(cfg);
}
