"use client";

import { useSyncExternalStore } from "react";

/** Registered once, at the origin root, so it can handle every page and the push events. */
export const SW_URL = "/sw.js";
/** The hub's id for THIS browser's push subscription, kept so Settings can mark "this device" and turn it off. */
export const PUSH_DEVICE_KEY = "tugra.pushDevice";

/** VAPID `applicationServerKey` arrives base64url; PushManager.subscribe wants bytes. */
export function urlBase64ToUint8Array(b64u: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** True when two byte strings are equal (used to tell whether an existing subscription uses the hub's current key). */
export function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

/** A short, human label for the device list: "Chrome on macOS". Product names, not copy. */
export function describeDevice(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return browser && os ? `${browser} on ${os}` : browser || os;
}

export function isIos(): boolean {
  return typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
}

/** Running as an installed app (any platform). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches === true || nav.standalone === true;
}

export type PushSupport = "ok" | "unsupported" | "insecure" | "ios-needs-install";

/** Why push can or cannot work here. iOS only exposes it to an installed web app. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!window.isSecureContext) return "insecure";
  const has = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!has) return isIos() && !isStandalone() ? "ios-needs-install" : "unsupported";
  return "ok";
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch {
    return null; // the panel works without it
  }
}

// ---- install prompt (Chromium's beforeinstallprompt, captured early so Settings can offer it later) ----

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installedFlag = false;
let started = false;
const listeners = new Set<() => void>();
let snapshot = { canInstall: false, installed: false };

function publish() {
  snapshot = { canInstall: deferred !== null, installed: installedFlag };
  listeners.forEach((l) => l());
}

/** Idempotent: call once at startup. */
export function startInstallCapture(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  installedFlag = isStandalone();
  snapshot = { canInstall: false, installed: installedFlag };
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // hold it: the browser's own mini-infobar would pre-empt the Settings button
    deferred = e as BeforeInstallPromptEvent;
    publish();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedFlag = true;
    publish();
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const SERVER_SNAPSHOT = { canInstall: false, installed: false };

export function useInstallPrompt(): { canInstall: boolean; installed: boolean; install: () => Promise<"accepted" | "dismissed" | "unavailable"> } {
  const s = useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);
  return {
    ...s,
    install: async () => {
      if (!deferred) return "unavailable";
      const ev = deferred;
      deferred = null; // a prompt event can be used once
      publish();
      await ev.prompt();
      const { outcome } = await ev.userChoice;
      return outcome;
    },
  };
}

/** Test seam: reset module state. */
export function __resetInstallCaptureForTests(): void {
  deferred = null;
  installedFlag = false;
  started = false;
  snapshot = { canInstall: false, installed: false };
  listeners.clear();
}

// ---- push subscription for this browser ----

export function storedDeviceId(): string | null {
  try {
    return localStorage.getItem(PUSH_DEVICE_KEY);
  } catch {
    return null;
  }
}
export function storeDeviceId(id: string | null): void {
  try {
    if (id) localStorage.setItem(PUSH_DEVICE_KEY, id);
    else localStorage.removeItem(PUSH_DEVICE_KEY);
  } catch {
    /* private mode: Settings just won't mark "this device" */
  }
}

/** This browser's current push subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok") return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/**
 * Subscribe this browser with the hub's VAPID key. A subscription made under a DIFFERENT key (the hub was reinstalled)
 * is dropped first: the push service would refuse to reuse it.
 */
export async function subscribeThisBrowser(publicKey: string): Promise<PushSubscription> {
  const key = urlBase64ToUint8Array(publicKey);
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    if (sameBytes(existing.options?.applicationServerKey, key)) return existing;
    await existing.unsubscribe();
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** The JSON body the hub wants for a subscription. */
export function subscriptionBody(sub: PushSubscription, deviceLabel?: string): { endpoint: string; keys: { p256dh: string; auth: string }; deviceLabel?: string } {
  const j = sub.toJSON();
  return {
    endpoint: String(j.endpoint),
    keys: { p256dh: String(j.keys?.p256dh ?? ""), auth: String(j.keys?.auth ?? "") },
    ...(deviceLabel ? { deviceLabel } : {}),
  };
}
