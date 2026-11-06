import { Injectable } from "@nestjs/common";
import { CoolifySource } from "./coolify.source";
import { CoolifyClientFactory } from "./coolify-client.factory";
import type { ImportSource } from "../import-source";
import type { RemoteSourceKind } from "../dto";

/**
 * Builds a remote {@link ImportSource} (Coolify today; Dokploy/CapRover/… next) for a given source kind.
 * The ONE place that knows which adapter + HTTP client a remote kind uses, so the importer service and the
 * apply executor stay source-agnostic (they switch on the session's `sourceKind`, never on a concrete class).
 *
 * `local-docker` is NOT built here: it has no stored session / HTTP client (it adopts live containers via the
 * migrator), so the importer service constructs {@link LocalDockerSource} directly.
 */
@Injectable()
export class ImportSourceFactory {
  constructor(private readonly coolifyClients: CoolifyClientFactory) {}

  /** Construct the adapter for `kind`, with its transport client already wired to `baseUrl` + `token`. */
  create(kind: RemoteSourceKind, baseUrl: string, token: string): ImportSource {
    switch (kind) {
      case "coolify":
        return new CoolifySource(this.coolifyClients.create(baseUrl, token));
      default: {
        // Exhaustiveness: when a new RemoteSourceKind is added without a case here, this line fails to
        // compile — the compiler is the reminder to register the adapter.
        const _exhaustive: never = kind;
        throw new Error(`unsupported import source: ${String(_exhaustive)}`);
      }
    }
  }

  /** Human-facing label for messages ("could not reach Coolify"). Total over every kind. */
  label(kind: RemoteSourceKind): string {
    switch (kind) {
      case "coolify":
        return "Coolify";
      default:
        return String(kind);
    }
  }
}
