/**
 * Tiny module-level pub/sub so non-React code (the TanStack QueryClient's
 * MutationCache) can raise toasts that the React <ToastProvider> renders.
 */
export type ToastType = "error" | "success" | "info";

/** Optional one-tap action on a toast (e.g. Undo). Running it dismisses the toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface ToastOptions {
  action?: ToastAction;
  /** Override the auto-dismiss delay (ms). Errors default to a longer delay than success/info. */
  durationMs?: number;
}
export interface ToastInput extends ToastOptions {
  message: string;
  type: ToastType;
}

type Listener = (t: ToastInput) => void;
const listeners = new Set<Listener>();

export function subscribeToast(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emitToast(message: string, type: ToastType = "info", opts: ToastOptions = {}): void {
  for (const fn of listeners) fn({ message, type, action: opts.action, durationMs: opts.durationMs });
}
