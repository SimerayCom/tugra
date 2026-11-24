"use client";

import { useEffect } from "react";
import { registerServiceWorker, startInstallCapture } from "../lib/pwa";

/**
 * Mounted once in the root layout: registers the service worker (offline page + push) and starts listening for the
 * browser's install prompt so Settings can offer it later. Renders nothing.
 */
export function PwaRegister() {
  useEffect(() => {
    startInstallCapture();
    void registerServiceWorker();
  }, []);
  return null;
}
