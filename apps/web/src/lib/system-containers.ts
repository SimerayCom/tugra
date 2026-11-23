"use client";

import { useCallback, useEffect, useState } from "react";

/** Tugra's own containers (hub-api, web, postgres, redis, proxy, agent, updater) carry kind "system".
 *  Lists hide them by default so the user's apps lead; one shared, remembered toggle shows them. */
const KEY = "tugra.showSystemContainers";
const EVENT = "tugra:show-system-containers";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function useShowSystemContainers(): [boolean, (v: boolean) => void] {
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(read());
    const sync = () => setShow(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const update = useCallback((v: boolean) => {
    setShow(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* private mode: the choice just isn't remembered */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [show, update];
}

export interface SystemSummary {
  count: number;
  cpu: number;
  memUsed: number;
}

/** Split rows into what to list and a summary of the hidden system rows (count, summed CPU and RAM). */
export function splitSystem<T extends { kind: string; cpu?: number; memUsed?: number }>(
  rows: T[],
  show: boolean,
): { visible: T[]; system: SystemSummary } {
  const sys = rows.filter((r) => r.kind === "system");
  const system = {
    count: sys.length,
    cpu: sys.reduce((a, r) => a + (r.cpu ?? 0), 0),
    memUsed: sys.reduce((a, r) => a + (r.memUsed ?? 0), 0),
  };
  return { visible: show ? rows : rows.filter((r) => r.kind !== "system"), system };
}
