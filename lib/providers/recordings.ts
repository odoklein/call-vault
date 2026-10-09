// Per-provider knowledge about recordings' media files: where the URL sits in a stored payload,
// and what auth fetching it needs. Separate from each provider's list-API client because it's used
// by a different caller (the recording-mirror queue, scripts/remirror-recordings.ts) and may be a
// different scheme entirely (signed URL vs Authorization header) — adding a provider means adding
// one case here, not hunting down every fetch() call site.

import { alloRecordingUrl } from "./allo/normalize";

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

/** The provider media URL recorded in a call's latest rawPayload, if any. */
export function recordingUrlFromPayload(providerSlug: string, rawPayload: unknown): string | undefined {
  switch (providerSlug) {
    case "allo":
      return alloRecordingUrl(rawPayload);
    default:
      return undefined;
  }
}
