/**
 * A fake server for the in-place takeover specs: it answers the hub's scripts the way a real box would (by recognising which script it was
 * given) and keeps the state they change: Coolify's proxy and containers, Tugra's proxy and apps, volumes, images, certificates. Specs
 * assert on what the box ended up looking like, not on script text. It is also an {@link InPlaceWorld}.
 */
import { createHash } from "node:crypto";
import { buildProxyStopScript } from "../deploy/deploy-script";
import type { DeployState, InPlaceWorld, OpApp, WorldApp, WorldServer } from "./inplace-world";

export const H = (c: string): string => c.repeat(64);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
export const PROXY_ID = H("1");

export interface BoxApp {
  appId: string;
  itemRef: string;
  name: string;
  host: string;
  ctrId: string;
  ctrName: string;
  image: string;
  /** Coolify's container mounts: a rw volume makes the app exclusive. */
  mounts?: Array<{ type: "volume" | "bind"; source: string; dest: string; rw: boolean }>;
  volumes?: Array<{ name: string; path: string }>;
  ctrRunning?: boolean;
  restart?: string;
}

interface Ctr {
  name: string;
  image: string;
  running: boolean;
  restart: string;
  mounts: NonNullable<BoxApp["mounts"]>;
}

export class Box implements InPlaceWorld {
  scripts: string[] = [];
  teamId = "team1";
  serverId = "srv1";
  serverName = "olgu-box";
  status = "ONLINE";
  capabilities = ["deploy"];
  bind = "public";
  controlPlane = "";
  apps: BoxApp[] = [];
  ctrs = new Map<string, Ctr>();
  coolifyProxy = { running: true, restart: "unless-stopped" };
  tugraProxy: { state: "absent" | "running" | "exited"; published: boolean } = { state: "absent", published: false };
  tugraRunning = new Set<string>();
  images = new Set<string>();
  tags = new Set<string>();
  volumes = new Set<string>();
  aliases = new Map<string, string>();
  acme = new Set<string>();
  fallback = new Map<string, string>();
  leIssued = new Set<string>();
  leWorks = true;
  /** hosts whose page differs through Tugra, and hosts whose page changes on every request */
  differs = new Set<string>();
  dynamic = new Set<string>();
  noCurl = false;
  failProxyStop = false;
  failAdopted = new Set<string>();
  failStopCtr = new Set<string>();
  deployStates = new Map<string, DeployState>();
  proxyBinds: string[] = [];
  busy = false;
  deploymentSeq = 0;
  adopted = new Map<string, string>();
  dropped: string[] = [];
  stoppedApps: string[] = [];
  sleeps = 0;
  events: string[] = [];
  clock = new Date("2026-11-26T10:00:00Z");
  certSeq = 0;
  private pendingLe = new Set<string>();

  add(a: BoxApp): this {
    this.apps.push(a);
    this.ctrs.set(a.ctrId, { name: a.ctrName, image: a.image, running: a.ctrRunning ?? true, restart: a.restart ?? "unless-stopped", mounts: a.mounts ?? [] });
    this.images.add(a.image);
    for (const m of a.mounts ?? []) if (m.type === "volume") this.volumes.add(m.source);
    this.acme.add(a.host);
    return this;
  }

  // ───────────── who owns :443 and what they answer ─────────────

  private tugraOwnsPorts(): boolean {
    return this.tugraProxy.state === "running" && this.tugraProxy.published;
  }
  private page(host: string, via: "coolify" | "tugra"): { status: number; content: string } {
    const app = this.apps.find((a) => a.host === host);
    if (!app) return { status: 404, content: "404 page not found" };
    if (via === "coolify") return app.ctrId && this.ctrs.get(app.ctrId)?.running ? { status: 200, content: `page ${host}` } : { status: 502, content: "bad gateway" };
    if (!this.tugraRunning.has(app.appId)) return { status: 404, content: "404 page not found" };
    return { status: 200, content: this.differs.has(host) ? `other ${host}` : `page ${host}` };
  }
  private answer(host: string, who: "coolify" | "tugra", n: number): { status: number; hash: string } {
    const p = this.page(host, who);
    const dyn = this.dynamic.has(host) && who === "coolify" ? `#${n}` : "";
    return { status: p.status, hash: sha(p.content + dyn) };
  }

  // ───────────── the agent shell ─────────────

  async exec(_serverId: string, script: string): Promise<{ exitCode: number; output: string }> {
    this.scripts.push(script);
    return { exitCode: 0, output: this.route(script) };
  }

  private hostsIn(script: string, re: RegExp): string[] {
    return [...script.matchAll(re)].map((m) => m[1]);
  }

  private route(s: string): string {
    if (s.includes("TUGRA_SWAP_END")) {
      return ["TUGRA_SWAP_ID=" + PROXY_ID, "TUGRA_SWAP_NAME=/coolify-proxy", "TUGRA_SWAP_IMAGE=traefik:v3.1", `TUGRA_SWAP_RESTART=${this.coolifyProxy.restart}`, `TUGRA_SWAP_RUNNING=${this.coolifyProxy.running}`, "TUGRA_SWAP_PORTS=80>80/tcp,443>443/tcp,", `TUGRA_SWAP_CONTROL_PLANE=${this.controlPlane}`, "TUGRA_SWAP_END"].join("\n");
    }
    if (s.includes('docker update --restart=no "$ID"') && s.includes('docker stop "$ID"')) {
      if (this.failProxyStop) return "TUGRA_SWAP_UPDATE_FAILED";
      this.events.push("coolify-proxy:stop");
      this.coolifyProxy = { running: false, restart: "no" };
      return "TUGRA_SWAP_SOURCE_RUNNING=false";
    }
    if (s.includes("docker stop tugra-proxy") && s.includes('docker start "$ID"')) {
      this.events.push("proxy:reverse");
      this.tugraProxy = { state: this.tugraProxy.state === "absent" ? "absent" : "exited", published: false };
      const pol = /docker update --restart=([a-z-]+) "\$ID"/.exec(s)?.[1] ?? "no";
      this.coolifyProxy = { running: true, restart: pol };
      return [`TUGRA_SWAP_SOURCE_RUNNING=true`, `TUGRA_SWAP_TARGET=${this.tugraProxy.state}`].join("\n");
    }
    if (s.includes("TUGRA_SWAP_STATUS_END")) {
      return [`TUGRA_SWAP_SOURCE_RUNNING=${this.coolifyProxy.running}`, `TUGRA_SWAP_TARGET=${this.tugraProxy.state}`, `TUGRA_SWAP_TARGET_PORTS=${this.tugraProxy.published ? "80>80/tcp,443>443/tcp," : ""}`, "TUGRA_SWAP_STATUS_END"].join("\n");
    }
    if (s === buildProxyStopScript()) {
      this.events.push("proxy:stop");
      this.tugraProxy = { state: this.tugraProxy.state === "absent" ? "absent" : "exited", published: false };
      return "";
    }
    if (s.includes("TUGRA_CTR")) {
      return this.apps.map((a) => ["TUGRA_CTR", a.itemRef, a.ctrId, a.ctrName, a.image, "", this.ctrs.get(a.ctrId)?.running ? "running" : "exited"].join("\t")).join("\n");
    }
    if (s.includes("TUGRA_IP_DETAIL_END")) {
      const out: string[] = [];
      for (const id of this.hostsIn(s, /^detail '([0-9a-f]{64})'/gm)) {
        const c = this.ctrs.get(id);
        if (!c) continue;
        out.push(`TUGRA_IP_RESTART|${id}|${c.restart}`, `TUGRA_IP_IMAGE|${id}|sha256:${H("e")}`);
        for (const m of c.mounts) out.push(`TUGRA_IP_MOUNT|${id}|${m.type}|${m.type === "volume" ? m.source : ""}|${m.type === "volume" ? `/var/lib/docker/volumes/${m.source}/_data` : m.source}|${m.dest}|${m.rw}`);
      }
      out.push("TUGRA_IP_DETAIL_END");
      return out.join("\n");
    }
    if (s.includes("TUGRA_IP_ADOPT")) {
      const m = /docker image inspect '([^']+)'.*\n.*docker tag '([^']+)' '([^']+)'/.exec(s);
      if (!m || !this.images.has(m[1])) return "TUGRA_IP_ADOPT|missing";
      this.tags.add(m[3]);
      this.events.push(`tag:${m[3]}`);
      return "TUGRA_IP_ADOPT|ok";
    }
    if (s.includes("TUGRA_IP_ALIAS")) {
      const out: string[] = [];
      for (const m of s.matchAll(/^alias_one '([^']+)' '([^']+)'/gm)) {
        const [, from, to] = m;
        if (!this.volumes.has(from)) out.push(`TUGRA_IP_ALIAS|${to}|nosource`);
        else if (this.aliases.has(to)) out.push(`TUGRA_IP_ALIAS|${to}|${this.aliases.get(to) === from ? "present" : "foreign"}`);
        else {
          this.aliases.set(to, from);
          this.events.push(`alias:${to}`);
          out.push(`TUGRA_IP_ALIAS|${to}|created`);
        }
      }
      return out.join("\n");
    }
    if (s.includes("TUGRA_IP_POLICY")) {
      const out: string[] = [];
      for (const m of s.matchAll(/^set_policy '([0-9a-f]{64})' '[^']+' '[^']+' '([a-z-]+)'/gm)) {
        const c = this.ctrs.get(m[1]);
        if (!c) out.push(`TUGRA_IP_POLICY|${m[1]}|gone`);
        else {
          c.restart = m[2];
          this.events.push(`policy:${m[2]}`);
          out.push(`TUGRA_IP_POLICY|${m[1]}|ok`);
        }
      }
      return out.join("\n");
    }
    if (s.includes("TUGRA_STOP")) {
      const out: string[] = [];
      for (const id of this.hostsIn(s, /^stop_one '([0-9a-f]{64})'/gm)) {
        const c = this.ctrs.get(id);
        if (!c) out.push(`TUGRA_STOP\t${id}\tgone`);
        else if (this.failStopCtr.has(id)) out.push(`TUGRA_STOP\t${id}\tfailed`);
        else {
          c.running = false;
          this.events.push(`coolify-ctr:stop:${c.name}`);
          out.push(`TUGRA_STOP\t${id}\tstopped`);
        }
      }
      return out.join("\n");
    }
    if (s.includes("TUGRA_START")) {
      const out: string[] = [];
      for (const id of this.hostsIn(s, /^start_one '([0-9a-f]{64})'/gm)) {
        const c = this.ctrs.get(id);
        if (!c) out.push(`TUGRA_START\t${id}\tgone`);
        else {
          c.running = true;
          this.events.push(`coolify-ctr:start:${c.name}`);
          out.push(`TUGRA_START\t${id}\tstarted`);
        }
      }
      return out.join("\n");
    }
    if (s.includes("TUGRA_IP_PROBE")) return this.probeOut(s);
    if (s.includes("TUGRA_IP_FALLBACK_REMOVED")) {
      for (const m of s.matchAll(/tls-fb-([a-z0-9-]+)\.yml/g)) {
        const host = this.apps.find((a) => a.host.replace(/[^a-z0-9]/g, "-") === m[1])?.host;
        if (host) {
          this.fallback.delete(host);
          if (this.leWorks) this.pendingLe.add(host);
          this.events.push(`fallback:remove:${host}`);
        }
      }
      return "TUGRA_IP_FALLBACK_REMOVED";
    }
    if (s.includes("TUGRA_IP_FALLBACK")) {
      const out: string[] = [];
      for (const m of s.matchAll(/^one '([^']+)' '[^']+'/gm)) {
        const h = m[1];
        if (!this.acme.has(h)) out.push(`TUGRA_IP_FALLBACK|${h}|absent|-`);
        else {
          const ser = `0F${(this.certSeq += 1).toString(16).toUpperCase()}`;
          this.fallback.set(h, ser);
          this.pendingLe.delete(h);
          this.events.push(`fallback:install:${h}`);
          out.push(`TUGRA_IP_FALLBACK|${h}|installed|${ser}`);
        }
      }
      return out.join("\n");
    }
    if (s.includes("TUGRA_IP_CERT")) {
      const h = /^H='([^']+)'/m.exec(s)?.[1] ?? "";
      if (this.pendingLe.has(h)) {
        this.pendingLe.delete(h);
        this.leIssued.add(h);
      }
      if (this.leIssued.has(h)) return `TUGRA_IP_CERT|${h}|served|AA${h.length}|C=US, O=Let's Encrypt, CN=R11`;
      const fb = this.fallback.get(h);
      return fb ? `TUGRA_IP_CERT|${h}|served|${fb}|CN=Coolify old CA` : `TUGRA_IP_CERT|${h}|none|-|-`;
    }
    return "";
  }

  private probeOut(s: string): string {
    if (this.noCurl) return "TUGRA_IP_PROBE|NOCURL\nTUGRA_IP_PROBE_END";
    const dark = s.includes("tugra-proxy");
    if (dark && this.tugraProxy.state !== "running") return "TUGRA_IP_PROBE|NOPROXY\nTUGRA_IP_PROBE_END";
    const twice = !s.includes("c2=$c1");
    const hosts = /for H in ([^;]+); do/.exec(s)?.[1].match(/'([^']+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
    const who: "coolify" | "tugra" = dark || this.tugraOwnsPorts() ? "tugra" : "coolify";
    const out = hosts.map((h) => {
      const a = this.answer(h, who, 1);
      const b = twice ? this.answer(h, who, 2) : a;
      return `TUGRA_IP_PROBE|${h}|${a.status}|${a.hash}|${b.hash}`;
    });
    this.events.push(`probe:${dark ? "dark" : who === "tugra" ? "local" : "coolify"}`);
    return [...out, "TUGRA_IP_PROBE_END"].join("\n");
  }

  // ───────────── the world ─────────────

  async server(id: string): Promise<WorldServer | null> {
    return id === this.serverId ? { id, teamId: this.teamId, name: this.serverName, status: this.status, capabilities: this.capabilities, proxyBind: this.bind } : null;
  }
  async opApps(opId: string): Promise<OpApp[] | null> {
    return opId === "op1" ? this.apps.map((a) => ({ appId: a.appId, itemRef: a.itemRef })) : null;
  }
  async app(appId: string): Promise<WorldApp | null> {
    const a = this.apps.find((x) => x.appId === appId);
    return a ? { id: a.appId, teamId: this.teamId, serverId: this.serverId, name: a.name, hosts: [a.host], volumes: a.volumes ?? [], hostMounts: [] } : null;
  }
  async setProxyBind(_s: string, bind: "public" | "loopback" | "none"): Promise<void> {
    this.bind = bind;
    this.proxyBinds.push(bind);
    this.events.push(`bind:${bind}`);
  }
  async startProxy(): Promise<void> {
    const published = this.bind === "public";
    if (published && this.coolifyProxy.running) throw new Error("port is already allocated");
    this.tugraProxy = { state: "running", published };
    this.events.push(`proxy:start:${this.bind}`);
  }
  async proxyStatus(): Promise<"running" | "stopped" | "absent"> {
    return this.tugraProxy.state === "absent" ? "absent" : this.tugraProxy.state === "running" ? "running" : "stopped";
  }
  async serverBusy(): Promise<boolean> {
    return this.busy;
  }
  async createAdoptDeployment(appId: string): Promise<string> {
    const id = `dep${(this.deploymentSeq += 1)}`;
    this.adopted.set(id, appId);
    return id;
  }
  async dropAdoptDeployment(id: string): Promise<void> {
    this.dropped.push(id);
    this.adopted.delete(id);
  }
  async runAdopted(_u: string, appId: string, deploymentId: string): Promise<{ ok: boolean }> {
    if (this.failAdopted.has(appId)) return { ok: false };
    const tag = `tugra_${appId}:${deploymentId}`;
    if (!this.tags.has(tag)) return { ok: false };
    // two containers on one data directory are never allowed to run at once
    const app = this.apps.find((a) => a.appId === appId)!;
    const c = this.ctrs.get(app.ctrId)!;
    if (c.running && c.mounts.some((m) => m.rw)) throw new Error("two containers would share writable data");
    this.tugraRunning.add(appId);
    this.events.push(`tugra-app:start:${appId}`);
    return { ok: true };
  }
  async rebuild(_u: string, appId: string): Promise<{ deploymentId: string }> {
    const id = `build${(this.deploymentSeq += 1)}`;
    this.deployStates.set(id, "RUNNING");
    this.adopted.set(id, appId);
    return { deploymentId: id };
  }
  async deployState(id: string): Promise<DeployState> {
    return this.deployStates.get(id) ?? "unknown";
  }
  async stopApp(_u: string, appId: string): Promise<void> {
    this.tugraRunning.delete(appId);
    this.stoppedApps.push(appId);
    this.events.push(`tugra-app:stop:${appId}`);
  }
  async sleep(): Promise<void> {
    this.sleeps += 1;
    this.clock = new Date(this.clock.getTime() + 5_000);
  }
  now(): Date {
    return this.clock;
  }
}
