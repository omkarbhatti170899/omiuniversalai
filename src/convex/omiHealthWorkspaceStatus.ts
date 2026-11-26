// Shared helpers for the public workspace-backend status surface.
// These are purposely tiny and side-effect-free.

export function isProviderFree(id: string): boolean {
  return id === "groq";
}

export function isGeneralWebSource(id: string): boolean {
  return id === "searxng" || id === "mwmbl";
}

