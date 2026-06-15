import type {
  BulkOperation,
  Channel,
  Heartbeat,
  MetricsSample,
  Monitor,
  PublicUser,
  ServerView,
  Team,
  TokenPair,
} from "./types";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

const ACCESS_KEY = "tugra.access";
const REFRESH_KEY = "tugra.refresh";

export const tokens = {
  access(): string | null {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(ACCESS_KEY);
  },
  refresh(): string | null {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(REFRESH_KEY);
  },
  set(pair: TokenPair): void {
    localStorage.setItem(ACCESS_KEY, pair.accessToken);
    localStorage.setItem(REFRESH_KEY, pair.refreshToken);
  },
  clear(): void {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function tryRefresh(): Promise<boolean> {
  const rt = tokens.refresh();
  if (!rt) return false;
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: rt }),
  });
  if (!res.ok) {
    tokens.clear();
    return false;
  }
  tokens.set((await res.json()) as TokenPair);
  return true;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const access = tokens.access();
  if (access) headers.set("authorization", `Bearer ${access}`);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401 && retry && (await tryRefresh())) {
    return apiFetch<T>(path, init, false);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = Array.isArray(body?.message)
        ? body.message.join(", ")
        : (body?.message ?? msg);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── typed endpoints ────────────────────────────────────────────────

export const api = {
  async register(email: string, password: string, name?: string) {
    const out = await apiFetch<{ user: PublicUser; tokens: TokenPair }>(
      "/auth/register",
      { method: "POST", body: JSON.stringify({ email, password, name }) },
      false,
    );
    tokens.set(out.tokens);
    return out.user;
  },

  async login(email: string, password: string, totp?: string) {
    const out = await apiFetch<
      { tokens: TokenPair } | { twoFaRequired: true }
    >(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password, totp }) },
      false,
    );
    if ("tokens" in out) tokens.set(out.tokens);
    return out;
  },

  me() {
    return apiFetch<PublicUser>("/auth/me");
  },

  async logout() {
    const rt = tokens.refresh();
    if (rt) {
      await apiFetch(
        "/auth/logout",
        { method: "POST", body: JSON.stringify({ refreshToken: rt }) },
        false,
      ).catch(() => undefined);
    }
    tokens.clear();
  },

  setup2fa() {
    return apiFetch<{ otpauthUrl: string; qrDataUrl: string }>(
      "/auth/2fa/setup",
      { method: "POST" },
    );
  },

  enable2fa(token: string) {
    return apiFetch<{ ok: true }>("/auth/2fa/enable", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  listTeams() {
    return apiFetch<Team[]>("/teams");
  },

  listServers(params?: { teamId?: string; status?: string }) {
    const q = new URLSearchParams();
    if (params?.teamId) q.set("teamId", params.teamId);
    if (params?.status) q.set("status", params.status);
    const qs = q.toString();
    return apiFetch<ServerView[]>(`/servers${qs ? `?${qs}` : ""}`);
  },

  getServer(id: string) {
    return apiFetch<ServerView>(`/servers/${id}`);
  },

  getMetrics(id: string, limit = 60) {
    return apiFetch<MetricsSample[]>(`/servers/${id}/metrics?limit=${limit}`);
  },

  createServer(name: string, teamId: string) {
    return apiFetch<{
      server: ServerView;
      enrollToken: string;
      installCommand: string;
    }>("/servers", {
      method: "POST",
      body: JSON.stringify({ name, teamId }),
    });
  },

  // ── monitors ──
  listMonitors() {
    return apiFetch<Monitor[]>("/monitors");
  },
  getMonitor(id: string) {
    return apiFetch<Monitor>(`/monitors/${id}`);
  },
  createMonitor(input: {
    name: string;
    type: "HTTP" | "TCP";
    target: string;
    teamId: string;
    channelIds?: string[];
  }) {
    return apiFetch<Monitor>("/monitors", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  checkMonitor(id: string) {
    return apiFetch<{ status: string; ms: number; msg: string }>(
      `/monitors/${id}/check`,
      { method: "POST" },
    );
  },
  getHeartbeats(id: string, limit = 60) {
    return apiFetch<Heartbeat[]>(`/monitors/${id}/heartbeats?limit=${limit}`);
  },
  getUptime(id: string) {
    return apiFetch<{ percent: number; total: number }>(
      `/monitors/${id}/uptime`,
    );
  },

  // ── notification channels ──
  listChannels() {
    return apiFetch<Channel[]>("/channels");
  },
  createChannel(input: {
    name: string;
    type: string;
    teamId: string;
    config: Record<string, unknown>;
  }) {
    return apiFetch<Channel>("/channels", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  testChannel(id: string) {
    return apiFetch<{ ok: true }>(`/channels/${id}/test`, { method: "POST" });
  },
  deleteChannel(id: string) {
    return apiFetch<{ ok: true }>(`/channels/${id}`, { method: "DELETE" });
  },

  // ── bulk ops ──
  runBulk(serverIds: string[], command: string) {
    return apiFetch<{ opId: string }>("/bulk", {
      method: "POST",
      body: JSON.stringify({ serverIds, command }),
    });
  },
  getBulk(id: string) {
    return apiFetch<BulkOperation>(`/bulk/${id}`);
  },
};
