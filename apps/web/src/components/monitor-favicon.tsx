"use client";

import { useState } from "react";
import { Activity, Globe, Radio, Server } from "lucide-react";
import { faviconUrl } from "../lib/favicon";

/** Site favicon for an HTTP/keyword monitor (Globe fallback); glyphs for TCP/PING/DNS/METRIC. */
export function MonitorFavicon({ type, target, size = 18 }: { type: string; target: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (type === "METRIC") return <Server size={size} color="var(--c-tx3)" />;
  if (type === "PING") return <Radio size={size} color="var(--c-tx3)" />;
  if (type === "DNS") return <Globe size={size} color="var(--c-tx3)" />;
  if (type === "TCP") return <Activity size={size} color="var(--c-tx3)" />;
  const url = faviconUrl(target);
  if (!url || broken) return <Globe size={size} color="var(--c-tx3)" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" width={size} height={size} onError={() => setBroken(true)} style={{ borderRadius: 3, flexShrink: 0 }} />;
}
