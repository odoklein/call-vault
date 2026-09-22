import { getStorageProvider } from "../storage";

/**
 * Download a recording from the provider's media URL and push it into our own storage exactly
 * once. Returns the storage key, or null if the fetch failed (caller should mark the call
 * RecordingStatus.FAILED and retry later rather than losing the Call row over it).
 *
 * Two failure modes are treated as failure, not success:
 *  - non-2xx status
 *  - a 2xx response whose content-type isn't audio/* — some providers (WithAllo confirmed) 200 an
 *    unauthenticated/expired request with a login or summary HTML page instead of erroring, which
 *    silently "succeeds" if you only check res.ok. Pass `headers` for whatever auth the provider's
 *    recording endpoint needs (see lib/providers/recording-auth.ts) — but even with the right
 *    headers, keep this check as a backstop against the same failure mode recurring.
 */
export async function mirrorRecording(params: {
  recordingUrl: string;
  providerSlug: string;
  callId: string;
  headers?: Record<string, string>;
}): Promise<{ key: string } | null> {
  const { recordingUrl, providerSlug, callId, headers } = params;

  try {
    const res = await fetch(recordingUrl, { headers, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      console.warn(`[call-vault][audio] fetch failed status=${res.status} callId=${callId}`);
      return null;
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("audio/")) {
      console.warn(
        `[call-vault][audio] refusing non-audio response contentType="${contentType}" callId=${callId} ` +
          `(provider likely returned a login/redirect page instead of the recording — check the auth headers for "${providerSlug}")`,
      );
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = contentType.includes("wav") ? "wav" : contentType.includes("ogg") ? "ogg" : "mp3";
    const key = `${providerSlug}/${callId}.${ext}`;

    await getStorageProvider().upload(buffer, key, contentType);
    return { key };
  } catch (e) {
    console.warn(`[call-vault][audio] mirror error callId=${callId}`, e);
    return null;
  }
}
