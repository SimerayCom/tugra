import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { buildCatalog, templateMetaList, type TemplateDef, type TemplateMeta } from "../templates/catalog";

interface Snapshot {
  map: Map<string, TemplateDef>;
  metas: TemplateMeta[];
}

/**
 * The catalog the app reads: the bundled catalog OVERLAID by the last-good signed remote blob. Holds
 * an in-memory snapshot so the 5 sync consumers (including the `list()`→`view()` hot path) never hit
 * the DB per call. The snapshot is initialized to the bundled catalog in the CONSTRUCTOR (before any
 * IO — the offline-fallback anchor), replaced from the durable DB row on boot, and swapped atomically
 * after a successful sync. A rebuild constructs a whole new `{map, metas}` then assigns it in ONE
 * statement, so a concurrent reader sees either the whole old or the whole new snapshot, never a
 * half-built one (single-threaded JS; no lock needed).
 */
@Injectable()
export class TemplateCatalogService implements OnModuleInit {
  private readonly logger = new Logger(TemplateCatalogService.name);
  private current: Snapshot;

  constructor(private readonly prisma: PrismaService) {
    this.current = this.build({}); // bundled base, synchronously, before any IO
  }

  private build(remote: Record<string, TemplateDef>): Snapshot {
    const catalog = buildCatalog(remote);
    return { map: new Map(Object.entries(catalog)), metas: templateMetaList(catalog) };
  }

  async onModuleInit(): Promise<void> {
    // Load the durable last-good remote overlay (if any). DB down → keep the bundled snapshot.
    try {
      const row = await this.prisma.catalogSnapshot.findUnique({ where: { id: "singleton" } });
      const payload = row?.payload as { templates?: Record<string, TemplateDef> } | null;
      if (payload?.templates) {
        this.current = this.build(payload.templates);
        this.logger.log(`loaded remote catalog overlay (${Object.keys(payload.templates).length} templates)`);
      }
    } catch (e) {
      this.logger.warn(`catalog boot-load skipped (using bundled): ${String((e as Error)?.message ?? e)}`);
    }
  }

  /** Swap in a freshly-verified remote overlay (atomic single-ref assignment). */
  applyRemote(templates: Record<string, TemplateDef>): void {
    this.current = this.build(templates);
  }

  get(slug: string): TemplateDef | undefined {
    return this.current.map.get(slug);
  }

  metaList(): TemplateMeta[] {
    return this.current.metas;
  }

  all(): Record<string, TemplateDef> {
    return Object.fromEntries(this.current.map);
  }
}
