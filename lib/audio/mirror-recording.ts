import { getStorageProvider } from "../storage";

/**
 * Download a recording from the provider's media URL and push it into our own storage exactly
 * once. Returns the storage key, or null if the fetch failed (caller should mark the call
 * RecordingStatus.FAILED and retry later rather than losing the Call row over it).
 */
export async function mirrorRecording(params: {
  recordingUrl: string;
  providerSlug: string;
  callId: string;
}): Promise<{ key: string } | null> {
  const { recordingUrl, providerSlug, callId } = params;

  try {
    const res = await fetch(recordingUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      console.warn(`[call-vault][audio] fetch failed status=${res.status} callId=${callId}`);
      return null;
    }
    const contentType = res.headers.get("content-type") || "audio/mpeg";
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
