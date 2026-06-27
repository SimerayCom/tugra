/**
 * Tiny module-level pub/sub so non-React code (the TanStack QueryClient's
 * MutationCache) can raise toasts that the React <ToastProvider> renders.
 */
export type ToastType = "error" | "success" | "info";
export interface ToastInput {
  message: string;
  type: ToastType;
}

type Listener = (t: ToastInput) => void;
const listeners = new Set<Listener>();

export function subscribeToast(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitToast(message: string, type: ToastType = "info"): void {
  for (const fn of listeners) fn({ message, type });
}
