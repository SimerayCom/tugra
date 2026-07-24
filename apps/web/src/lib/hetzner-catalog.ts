// Mirrors apps/hub-api/src/cloud/hetzner-catalog.ts — keep the two in sync. Server-side re-validates
// every choice, so this list only drives the provision form's Selects.
export const HETZNER_LOCATIONS = [
  { value: "nbg1", label: "Nuremberg, DE" },
  { value: "fsn1", label: "Falkenstein, DE" },
  { value: "hel1", label: "Helsinki, FI" },
  { value: "ash", label: "Ashburn, VA (US East)" },
  { value: "hil", label: "Hillsboro, OR (US West)" },
  { value: "sin", label: "Singapore" },
];

export const HETZNER_SERVER_TYPES = [
  { value: "cx22", label: "CX22 — 2 vCPU · 4 GB · 40 GB" },
  { value: "cx32", label: "CX32 — 4 vCPU · 8 GB · 80 GB" },
  { value: "cx42", label: "CX42 — 8 vCPU · 16 GB · 160 GB" },
  { value: "cpx11", label: "CPX11 — 2 vCPU (AMD) · 2 GB · 40 GB" },
  { value: "cpx21", label: "CPX21 — 3 vCPU (AMD) · 4 GB · 80 GB" },
  { value: "cpx31", label: "CPX31 — 4 vCPU (AMD) · 8 GB · 160 GB" },
];
