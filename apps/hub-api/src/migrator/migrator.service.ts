import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
  ConflictException,
} from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ApplicationsService, type AppView } from "../applications/applications.service";
import {
  buildDiscoverScript,
  buildInspectOneScript,
  buildRenameScript,
  buildUnadoptScript,
  parseDiscovered,
  toPublicContainer,
  NO_DOCKER_MARKER,
  type TugraOwnedReason,
  type DiscoveredContainer,
  type DiscoveredEnv,
  type DiscoveredMount,
} from "./discover-script";
import { assertSafeDockerOptions } from "../deploy/docker-options-safety";
import type { AdoptInput, AdoptStackInput } from "./dto";
import { analyzeStacks, stackRefusalMessage, type DiscoveredStack } from "./stack-adopt";
import { composeServiceNames } from "../deploy/compose-script";
import { ComposeAdoptSchema, buildAdoptReadScript, parseAdoptRead, parseComposeAdopt, type ComposeAdopt } from "../deploy/compose-adopt";
import { autoFlagMultiline } from "../importer/env-auto-flags";

const DISCOVER_TIMEOUT_MS = 30_000;
const INSPECT_TIMEOUT_MS = 15_000;
const RENAME_TIMEOUT_MS = 15_000;
const ADOPT_READ_TIMEOUT_MS = 40_000;

/** Refusal text for adopting one of Tugra's own containers (a 400 — the caller asked for something never valid). */
export function tugraOwnedMessage(reason: TugraOwnedReason): string {
  const what: Record<TugraOwnedReason, string> = {
    stack: "part of Tugra's own install stack",
    proxy: "Tugra's reverse proxy",
    tunnel: "a Tugra-managed tunnel",
    helper: "a Tugra helper container",
    managed: "already managed by Tugra",
    reserved: "using a name reserved for Tugra (tugra-/tugra_)",
  };
  const hint = reason === "reserved" ? "; rename the container first if it is your own" : "";
  return `this container is ${what[reason]} and can't be adopted${hint}`;
}

export type AdoptableContainer = DiscoveredContainer & { adoptable: boolean };

/**
 * Migrator: scan an enrolled server for foreign (non-Tugra) Docker containers and adopt one as a
 * Tugra-managed app. Adoption creates the app record WITHOUT deploying, then `docker rename`s the
 * running container to Tugra's `tugra_<appId>` convention so every existing lifecycle path works
 * unchanged. Reuses the "deploy" capability (already default-granted, already used by listContainers).
 */
@Injectable()
export class MigratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly apps: ApplicationsService,
  ) {}

  /** Read-only scan: foreign containers on the host, each flagged whether it can be adopted. */
  async discover(userId: string, serverId: string): Promise<{ containers: AdoptableContainer[]; stacks: DiscoveredStack[] }> {
    await this.requireWrite(userId, serverId);
    const r = await this.agentWs.sendCommand(serverId, buildDiscoverScript(), "deploy", DISCOVER_TIMEOUT_MS);
    if (r.output.includes(NO_DOCKER_MARKER)) {
      throw new ServiceUnavailableException("Docker is not available on this server");
    }
    const parsed = parseDiscovered(r.output);
    // Compose projects, judged over the WHOLE host (a refusal can come from a member Tugra hides, or a name clash).
    const stacks = analyzeStacks(parsed);
    const containers = parsed
      .filter((c) => !c.isTugra) // never offer Tugra's own stack / proxy / tunnel / helpers / managed containers
      .map(toPublicContainer)
      .map((c) => ({
        ...c,
        // The client only needs env KEYS (to choose what to import); adopt() re-reads the values
        // fresh server-side. Don't ship potentially-secret env values over the wire.
        env: c.env.map((e) => ({ key: e.key, value: "" })),
        // compose-managed = not adoptable (v1); a Coolify/Dokploy container moves with that platform's import instead
        adoptable: c.composeProject === null && c.managedBy === null,
      }));
    return { containers, stacks };
  }

  /**
   * Adopt a whole docker compose project IN PLACE: nothing is recreated, renamed or touched. The project (its name,
   * working dir and config files, as docker labelled them) is registered as a Tugra compose app, so later deploys run
   * `docker compose -p <same project> -f <same files>`. Owner/admin only (the app then runs host files with the docker
   * socket); refuses Tugra's own and Coolify/Dokploy projects. Everything is re-read from the host here, never trusted
   * from the client or a cached discover.
   */
  async adoptStack(userId: string, serverId: string, dto: AdoptStackInput): Promise<AppView> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requireRole(userId, server.teamId, [Role.OWNER, Role.ADMIN]);
    await this.access.requirePermission(userId, server.teamId, "apps:config");

    const scan = await this.agentWs.sendCommand(serverId, buildDiscoverScript(), "deploy", DISCOVER_TIMEOUT_MS);
    if (scan.output.includes(NO_DOCKER_MARKER)) throw new ServiceUnavailableException("Docker is not available on this server");
    const stack = analyzeStacks(parseDiscovered(scan.output)).find((s) => s.project === dto.project);
    if (!stack) throw new NotFoundException("compose project not found on this server");
    if (!stack.adoptable) throw new BadRequestException(stackRefusalMessage(stack.reason ?? "no_config", stack.managedBy));

    // One registration per project per server: a second one would run the same stack under two apps.
    const existing = await this.prisma.application.findMany({
      where: { serverId, source: "COMPOSE", NOT: { composeAdopt: { equals: Prisma.DbNull } } },
      select: { id: true, composeAdopt: true },
    });
    if (existing.some((a) => parseComposeAdopt(a.composeAdopt)?.project === stack.project)) {
      throw new ConflictException("this compose project is already adopted on this server");
    }

    // Read the files as they are on the host (fingerprint + declared services; the content is parsed and dropped).
    const workingDir = stack.workingDir as string;
    const paths = stack.configFiles;
    let read: { exitCode: number; output: string };
    try {
      read = await this.agentWs.sendCommand(serverId, buildAdoptReadScript({ workingDir, files: paths.map((path) => ({ path, sha256: "", bytes: 0 })) }), "deploy", ADOPT_READ_TIMEOUT_MS);
    } catch {
      throw new ServiceUnavailableException("could not adopt the stack (agent unavailable)");
    }
    if (read.output.includes("TUGRA_COMPOSE_UNAVAILABLE")) {
      throw new ServiceUnavailableException("this agent doesn't know its own image, so the stack's files can't be read; re-run the agent install command");
    }
    const files = parseAdoptRead(read.output, paths.length);
    const unreadable = paths.filter((_, i) => !files[i].ok);
    if (read.exitCode !== 0 || unreadable.length > 0) {
      throw new BadRequestException(`could not read the compose file${unreadable.length > 1 ? "s" : ""} on the server (${unreadable.length > 0 ? unreadable.length : paths.length} missing or unreadable); the project can't be run by Tugra`);
    }

    // Services: what runs now, plus services the files declare but nothing runs yet (stopped / scaled to zero).
    const services: ComposeAdopt["services"] = stack.services.map((s) => ({
      name: s.service,
      image: s.image,
      ports: s.ports,
      volumes: stack.volumes.filter((v) => v.service === s.service).map((v) => ({ name: v.name, target: v.target })).slice(0, 30),
    }));
    for (const f of files) {
      for (const name of composeServiceNames(f.content)) {
        if (services.length < 100 && !services.some((s) => s.name === name)) services.push({ name, image: "", ports: [], volumes: [] });
      }
    }
    const parsed = ComposeAdoptSchema.safeParse({
      v: 1,
      project: stack.project,
      workingDir,
      files: paths.map((path, i) => ({ path, sha256: files[i].sha256, bytes: files[i].bytes })),
      services,
      adoptedAt: new Date().toISOString(),
    } satisfies ComposeAdopt);
    if (!parsed.success) throw new BadRequestException("this compose project can't be registered (unsupported names or paths)");

    const app = await this.apps.createAdoptedCompose(userId, {
      serverId,
      name: dto.name,
      environmentId: dto.environmentId,
      adopt: parsed.data,
      running: stack.services.some((s) => s.state === "running"),
    });
    // Counts and the project name only: never file paths contents, env or images.
    await this.audit.log({
      actor: userId,
      action: "app.adopt_stack",
      target: app.id,
      meta: { serverId, project: stack.project, services: services.length, files: paths.length },
    });
    return app;
  }

  /** Adopt one foreign container as a Tugra app: create record → rename → set status. */
  async adopt(userId: string, serverId: string, dto: AdoptInput): Promise<AppView> {
    await this.requireWrite(userId, serverId);

    // Re-inspect the target FRESH on the agent — never trust a client-cached discover() snapshot for
    // the fields that gate safety (identity / Tugra-ownership / compose membership). Closes TOCTOU.
    const inspect = await this.agentWs.sendCommand(
      serverId,
      buildInspectOneScript(dto.container),
      "deploy",
      INSPECT_TIMEOUT_MS,
    );
    const found = parseDiscovered(inspect.output)[0];
    if (!found) throw new NotFoundException("container not found");
    // Tugra's own containers can never be adopted — renaming one would break the panel/proxy/agent. Enforced here
    // (not just hidden in discover) so a direct API / MCP / CLI call is refused too.
    if (found.tugraReason) throw new BadRequestException(tugraOwnedMessage(found.tugraReason));
    if (found.composeProject) {
      // A compose-project member may still belong to Tugra's own stack (the bundled postgres/redis carry no Tugra
      // marker of their own): classify it against the whole host so it gets the precise refusal.
      // Best effort: the target is refused either way, so a failing scan must not turn the 400 into a 5xx.
      let again: ReturnType<typeof parseDiscovered>[number] | undefined;
      try {
        const all = await this.agentWs.sendCommand(serverId, buildDiscoverScript(), "deploy", DISCOVER_TIMEOUT_MS);
        again = parseDiscovered(all.output).find((c) => c.id === found.id || c.name === found.name);
      } catch {
        again = undefined;
      }
      if (again?.tugraReason) throw new BadRequestException(tugraOwnedMessage(again.tugraReason));
      throw new BadRequestException("compose-managed containers can't be adopted one by one; adopt the whole stack instead");
    }
    if (found.managedBy) throw new BadRequestException(`this container is managed by ${found.managedBy === "coolify" ? "Coolify" : "Dokploy"}; move it with the ${found.managedBy === "coolify" ? "Coolify" : "Dokploy"} import`);
    if (!found.image) throw new BadRequestException("could not determine the container's image");

    // An explicit port choice must actually exist on the freshly-inspected container — otherwise we'd
    // silently fall back to containerPort 80 and drop the real port (breaks a later redeploy's -p).
    if (dto.portIndex != null && dto.portIndex >= found.ports.length) {
      throw new BadRequestException("the selected port is not available on this container");
    }
    const chosen = found.ports[dto.portIndex ?? 0] ?? null;
    // Named volumes must follow the container to its first Tugra redeploy, otherwise the new container
    // starts EMPTY (data loss). Tugra's own volumes are namespaced per app, so the ORIGINAL volume is
    // re-attached by name via a dockerOptions `-v` pass-through. Computed BEFORE any write so an
    // un-carriable mount rejects the adopt cleanly instead of silently dropping data.
    const dockerOptions = volumeDockerOptions(found.mounts);
    assertSafeDockerOptions(dockerOptions);
    // A container env value with a line break is flagged Multiline (a name that cannot carry it rejects the adopt
    // here, before any write) instead of silently corrupting the env file.
    const adoptEnv = pickEnv(found.env, dto.envKeys);
    let adoptFlags: ReturnType<typeof autoFlagMultiline>;
    try {
      adoptFlags = autoFlagMultiline(adoptEnv);
    } catch (e) {
      throw new BadRequestException(`cannot adopt: ${(e as Error).message}`);
    }
    // Insert the app row only (deploy:false → no docker); exposeMode:none is mandatory (else create()
    // silently mints a magic sslip.io domain). All image/port/env values come from the fresh inspect.
    const app = await this.apps.create(userId, {
      name: dto.name,
      serverId,
      environmentId: dto.environmentId,
      source: "IMAGE",
      image: found.image,
      hostPort: chosen?.host ?? undefined, // undefined (Zod optional), never null
      containerPort: chosen?.container ?? 80,
      env: adoptEnv,
      ...(Object.keys(adoptFlags).length ? { envFlags: adoptFlags } : {}),
      exposeMode: "none",
      deploy: false,
      tags: ["adopted"],
    });

    if (dockerOptions) {
      try {
        await this.prisma.application.update({ where: { id: app.id }, data: { dockerOptions } });
      } catch {
        await this.apps.discardUndeployed(app.id);
        throw new ServiceUnavailableException("could not adopt the container (could not carry its volumes)");
      }
    }

    // Take ownership of the running container by renaming it to Tugra's convention. ANY failure — a
    // non-zero exit OR sendCommand rejecting (agent offline / timeout / capability) — must undo the
    // just-created record so no orphaned "adopted" app lingers; the foreign container is left as-is.
    let rename: { exitCode: number };
    try {
      rename = await this.agentWs.sendCommand(serverId, buildRenameScript(dto.container, `tugra_${app.id}`), "deploy", RENAME_TIMEOUT_MS);
    } catch {
      await this.apps.discardUndeployed(app.id);
      throw new ServiceUnavailableException("could not adopt the container (agent unavailable)");
    }
    if (rename.exitCode !== 0) {
      await this.apps.discardUndeployed(app.id);
      throw new ServiceUnavailableException("could not adopt the container (rename failed)");
    }

    await this.prisma.application.update({
      where: { id: app.id },
      data: { status: found.state === "running" ? "RUNNING" : "STOPPED" },
    });
    // Audit carries the ORIGINAL container name for traceability — never any imported env value.
    await this.audit.log({ actor: userId, action: "app.adopt", target: app.id, meta: { serverId, fromContainer: dto.container } });
    return this.apps.get(userId, app.id);
  }

  /**
   * Undo an adoption (importer rollback): rename the Tugra-managed container back to its original name, then
   * drop the app record. The rename runs via {@link buildUnadoptScript}, which succeeds (exit 0) both when it
   * renames and when the container is already gone. Only THEN is the record removed. A genuine failure — a
   * non-zero exit (e.g. the original name is taken) or a rejection (agent offline/timeout) — throws WITHOUT
   * deleting the record, so the caller records the failure and the task stays retryable (never a false
   * "rolled back" that orphans a live tugra_<appId> container).
   */
  async unadopt(userId: string, serverId: string, appId: string, originalName: string): Promise<void> {
    await this.requireWrite(userId, serverId);
    let r: { exitCode: number };
    try {
      r = await this.agentWs.sendCommand(serverId, buildUnadoptScript(`tugra_${appId}`, originalName), "deploy", RENAME_TIMEOUT_MS);
    } catch {
      throw new ServiceUnavailableException("could not roll back the adoption (agent unavailable)");
    }
    if (r.exitCode !== 0) {
      throw new ServiceUnavailableException("could not roll back the adoption (rename failed — the original name may be taken)");
    }
    await this.apps.discardUndeployed(appId);
    await this.audit.log({ actor: userId, action: "app.unadopt", target: appId, meta: { serverId, toContainer: originalName } });
  }

  private async requireWrite(userId: string, serverId: string): Promise<{ teamId: string }> {
    const server = await this.prisma.server.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    return server;
  }
}

// Strict charsets so the produced `-v name:/path` can never carry `,` `=` `:` whitespace or shell syntax.
const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MOUNT_TARGET_RE = /^\/[A-Za-z0-9._/-]+$/;

/**
 * Discovered `volume` mounts → a dockerOptions string (`-v <volume>:<target> …`) that re-attaches the
 * ORIGINAL named volumes on redeploy, or null when there are none. Bind/tmpfs mounts are not carried (a
 * bind is a host-path escape surface). Throws (fail closed) on a volume whose name/target can't be
 * expressed safely — better to refuse the adopt than to drop persistent data.
 */
export function volumeDockerOptions(mounts: DiscoveredMount[]): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const m of mounts) {
    if (m.type !== "volume") continue;
    if (!VOLUME_NAME_RE.test(m.source) || !MOUNT_TARGET_RE.test(m.target)) {
      throw new BadRequestException(
        `cannot adopt: the container's volume "${m.source}" mounted at "${m.target}" can't be carried over safely`,
      );
    }
    if (seen.has(m.target)) continue;
    seen.add(m.target);
    parts.push(`-v ${m.source}:${m.target}`);
  }
  return parts.length ? parts.join(" ") : null;
}

/** DiscoveredEnv[] → Record, keeping only `keys` when given (else all). */
function pickEnv(env: DiscoveredEnv[], keys?: string[]): Record<string, string> {
  const allow = keys ? new Set(keys) : null;
  const out: Record<string, string> = {};
  for (const e of env) {
    if (allow && !allow.has(e.key)) continue;
    out[e.key] = e.value;
  }
  return out;
}
