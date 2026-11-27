/**
 * Everything the in-place takeover touches outside its own row, behind one small port: the agent shell, the server's proxy settings,
 * the Tugra apps (adopt an image, start, stop, rebuild) and the import op's app list. The service never imports the real services;
 * the specs bind this to an in-memory fake and the module binds it to `InPlaceWorldService`.
 */
import type { ComposeNetworkRow } from "../deploy/deploy-script";

export const INPLACE_WORLD = Symbol("INPLACE_WORLD");

export interface WorldServer {
  id: string;
  teamId: string;
  name: string;
  /** `ONLINE` when the agent is connected. */
  status: string;
  capabilities: string[];
  proxyBind: string;
}

export interface WorldApp {
  id: string;
  teamId: string;
  serverId: string;
  name: string;
  /** The hosts the app serves: its domain, the extra domains and the compose service hosts (lower-case, unvalidated). */
  hosts: string[];
  volumes: Array<{ name: string; path: string }>;
  hostMounts: Array<{ hostPath: string; containerPath: string }>;
}

/** A Tugra database as the takeover needs it: what it runs on, where its data lives and which extra volumes it declares. */
export interface WorldDatabase {
  id: string;
  teamId: string;
  serverId: string;
  name: string;
  /** `POSTGRES`, `MYSQL`, ... */
  engine: string;
  /** The image Tugra runs it on (the row's own, else the engine's default for its version). */
  image: string;
  /** Where the image keeps its data (the engine's data directory, or the parent directory for the newer Postgres layout). */
  dataMount: string;
  volumes: Array<{ name: string; path: string }>;
}

/**
 * A compose service the import created on the server (a Coolify one-click service or docker-compose app, a stopped COMPOSE app in Tugra): the
 * app as the takeover knows every app, plus what it needs to map the Coolify containers to the compose services.
 */
export interface WorldService extends WorldApp {
  /** The compose project Tugra runs it under (its containers carry this as their project label). */
  project: string;
  /** The stored compose file; null when the app has none (a git compose, an adopted project: not for this takeover). */
  composeFile: string | null;
  /** The compose app's named volumes: the key, the docker volume it stands for and whether it is external. */
  composeVolumes: Array<{ key: string; dockerName: string; external: boolean }>;
  /** The network attachments the compose app has (hub-owned: the import's private network, say). */
  networks: ComposeNetworkRow[];
  /** A stored-compose app the takeover can drive: no git compose, no adopted project, no swarm cluster. */
  usable: boolean;
}

/** One service the import op created on the server, with the source item it came from. */
export interface OpService {
  appId: string;
  itemRef: string;
}

/** One database the import op created on the server, with the source item it came from. */
export interface OpDatabase {
  databaseId: string;
  itemRef: string;
}

/** One app the import op created on the server, with the source item it came from. */
export interface OpApp {
  appId: string;
  itemRef: string;
  /** The app's custom container name prefix at the source, when it has one. */
  containerPrefix?: string;
  /** Git commit Coolify built (hex), when the plan carried one. */
  commitSha?: string | null;
}

export type DeployState = "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "unknown";

export interface InPlaceWorld {
  server(serverId: string): Promise<WorldServer | null>;
  /** The apps the op created (team-checked by the caller) whose app row sits on `serverId`. */
  opApps(opId: string, teamId: string, serverId: string): Promise<OpApp[] | null>;
  app(appId: string): Promise<WorldApp | null>;
  /** The databases the op created (team-checked by the caller) whose row sits on `serverId`. */
  opDatabases(opId: string, teamId: string, serverId: string): Promise<OpDatabase[] | null>;
  /** The compose services the op created (team-checked by the caller) whose app row sits on `serverId`. */
  opServices(opId: string, teamId: string, serverId: string): Promise<OpService[] | null>;
  /** A compose service app as the takeover needs it. */
  service(appId: string): Promise<WorldService | null>;
  /** Replace the network attachments of the compose app's services (the whole list; empty clears). */
  setComposeNetworks(userId: string, appId: string, rows: ComposeNetworkRow[]): Promise<void>;
  /** A successful deployment row that carries the app's current compose file, so the rollback path can run the stack. Returns its id. */
  createAdoptComposeDeployment(appId: string): Promise<string>;
  database(databaseId: string): Promise<WorldDatabase | null>;
  /** Start Tugra's container for the database on its (aliased) data volume: the database's own provision. */
  runDatabase(userId: string, databaseId: string): Promise<{ ok: boolean }>;
  stopDatabase(userId: string, databaseId: string): Promise<void>;
  /**
   * Does the app's environment mention any of these names (the database container names it would connect to)? `null` when the environment could
   * not be read: the caller then treats the app as depending on them.
   */
  appMentions(appId: string, needles: readonly string[]): Promise<boolean | null>;
  /** Run a hub-built script on the host through the agent (`deploy` capability). */
  exec(serverId: string, script: string, timeoutMs?: number): Promise<{ exitCode: number; output: string }>;
  setProxyBind(serverId: string, bind: "public" | "loopback" | "none"): Promise<void>;
  /** Recreate Tugra's proxy from the server's current settings (the same action as the Start button). */
  startProxy(userId: string, serverId: string): Promise<void>;
  /** `running`, `stopped` or `absent`. */
  proxyStatus(userId: string, serverId: string): Promise<"running" | "stopped" | "absent">;
  /** Another takeover or a guided run that holds this server. The guided run `exceptRunId` (the one that carries the takeover) does not count. */
  serverBusy(serverId: string, exceptRunId?: string): Promise<boolean>;
  /** Is this guided run still going (it may still act on its takeover)? A run that ended, or does not exist any more, is not live. */
  runLive(runId: string): Promise<boolean>;
  /** A successful deployment row that stands for the image Coolify built, so the rollback path can run it. Returns its id. */
  createAdoptDeployment(appId: string, commitSha: string | null): Promise<string>;
  dropAdoptDeployment(deploymentId: string): Promise<void>;
  /** Run the adopted version (the app's rollback path: Tugra's env, labels, volumes and health gate). */
  runAdopted(userId: string, appId: string, deploymentId: string): Promise<{ ok: boolean }>;
  /** Tugra's own build of the app (queued); the state is read back with {@link deployState}. */
  rebuild(userId: string, appId: string): Promise<{ deploymentId: string }>;
  deployState(deploymentId: string): Promise<DeployState>;
  stopApp(userId: string, appId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}
