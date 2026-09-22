// Per-provider auth for fetching a recording's actual media file. Separate from each provider's
// API-list auth (lib/providers/<slug>/client.ts) because it's used by a different caller
// (mirrorRecording) and, for some providers, may end up being a different scheme entirely (signed
// URL vs Authorization header) — keeping it centralized here means adding a provider only means
// adding one case, not hunting down every fetch() call site.
export function getRecordingAuthHeaders(providerSlug: string): Record<string, string> | undefined {
  switch (providerSlug) {
    case "allo": {
      const key = process.env.ALLO_API_KEY;
      // WithAllo's recording endpoint 200s on unauthenticated requests too — it just redirects to
      // a login/summary HTML page instead of the audio. No Authorization header does NOT fail
      // loudly, which is exactly what made this bug silent in the first place.
      return key ? { Authorization: key } : undefined;
    }
    default:
      return undefined;
  }
}
