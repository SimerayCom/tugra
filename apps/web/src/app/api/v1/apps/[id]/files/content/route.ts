import { proxyToHub } from "../../../../../../../lib/hub-stream-proxy";

// File download (GET) and upload (PUT) for an app volume. Streamed straight through to the hub: the generic
// /api/v1 rewrite buffers (and truncates above 10 MiB) request bodies — see lib/hub-stream-proxy.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  return proxyToHub(req, `/api/v1/apps/${encodeURIComponent((await ctx.params).id)}/files/content`);
}

export async function PUT(req: Request, ctx: Ctx) {
  return proxyToHub(req, `/api/v1/apps/${encodeURIComponent((await ctx.params).id)}/files/content`);
}
