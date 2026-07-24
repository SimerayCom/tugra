/**
 * Curated Hetzner Cloud location / server-type / image options offered when provisioning. Hardcoded
 * (no live API listing in v1) — a small, stable set; validated server-side against a raw API caller.
 * Keep the web mirror (apps/web/src/lib/hetzner-catalog.ts) in sync.
 */
export const HETZNER_LOCATIONS = [
  { value: "nbg1", label: "Nuremberg, DE" },
  { value: "fsn1", label: "Falkenstein, DE" },
  { value: "hel1", label: "Helsinki, FI" },
  { value: "ash", label: "Ashburn, VA (US East)" },
  { value: "hil", label: "Hillsboro, OR (US West)" },
  { value: "sin", label: "Singapore" },
] as const;

export const HETZNER_SERVER_TYPES = [
  { value: "cx22", label: "CX22 — 2 vCPU · 4 GB RAM · 40 GB" },
  { value: "cx32", label: "CX32 — 4 vCPU · 8 GB RAM · 80 GB" },
  { value: "cx42", label: "CX42 — 8 vCPU · 16 GB RAM · 160 GB" },
  { value: "cpx11", label: "CPX11 — 2 vCPU (AMD) · 2 GB RAM · 40 GB" },
  { value: "cpx21", label: "CPX21 — 3 vCPU (AMD) · 4 GB RAM · 80 GB" },
  { value: "cpx31", label: "CPX31 — 4 vCPU (AMD) · 8 GB RAM · 160 GB" },
] as const;

export const HETZNER_IMAGES = [
  { value: "ubuntu-24.04", label: "Ubuntu 24.04" },
  { value: "ubuntu-22.04", label: "Ubuntu 22.04" },
  { value: "debian-12", label: "Debian 12" },
] as const;

export const HETZNER_DEFAULT_IMAGE = "ubuntu-24.04";

export const isValidHetznerLocation = (v: string): boolean => HETZNER_LOCATIONS.some((l) => l.value === v);
export const isValidHetznerServerType = (v: string): boolean => HETZNER_SERVER_TYPES.some((s) => s.value === v);
export const isValidHetznerImage = (v: string): boolean => HETZNER_IMAGES.some((i) => i.value === v);
