import { proxyToHub } from "../../../../../../../lib/hub-stream-proxy";

// Container-filesystem download (GET) and upload (PUT); streamed like the volume route (lib/hub-stream-proxy.ts).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  return proxyToHub(req, `/api/v1/apps/${encodeURIComponent((await ctx.params).id)}/container-files/content`);
}

export async function PUT(req: Request, ctx: Ctx) {
  return proxyToHub(req, `/api/v1/apps/${encodeURIComponent((await ctx.params).id)}/container-files/content`);
}
