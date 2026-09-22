// Incremental sync for one Allo line: walk pages forward (Allo returns newest-first) only until
// we reach a call already covered by the cursor, instead of always rescanning up to MAX_PAGES like
// the old per-action heuristic search did. This is the main lever that removes 429 pressure —
// once a cursor is warm, most runs fetch exactly one page (often zero new calls).

import { fetchAlloPage } from "./client";
import type { LineCursor, PollableCallProvider, SyncResult } from "../types";

const ALLO_API_KEY = process.env.ALLO_API_KEY ?? "";

export const alloProvider: PollableCallProvider = {
  slug: "allo",

  async syncLine(cursor: LineCursor, maxPages: number): Promise<SyncResult> {
    if (!ALLO_API_KEY) {
      throw new Error("ALLO_API_KEY not set");
    }

    const collected: SyncResult["calls"] = [];
    let newLastSyncedAt = cursor.lastSyncedAt;

    for (let page = 0; page < maxPages; page++) {
      const { calls, totalPages, httpOk, httpStatus } = await fetchAlloPage(ALLO_API_KEY, cursor.externalNumber, page);

      if (!httpOk) {
        // Surface as an error so the caller can record a circuit-breaker failure; whatever we
        // already collected on earlier pages this run is still returned (best effort).
        throw new Error(`Allo API error status=${httpStatus} line=${cursor.externalNumber} page=${page}`);
      }

      if (calls.length === 0) break;

      let hitKnownTerritory = false;
      for (const call of calls) {
        if (cursor.lastSyncedAt && call.startedAt && call.startedAt.getTime() <= cursor.lastSyncedAt.getTime()) {
          hitKnownTerritory = true;
          break; // newest-first: everything after this is even older
        }
        collected.push(call);
        if (call.startedAt && (!newLastSyncedAt || call.startedAt.getTime() > newLastSyncedAt.getTime())) {
          newLastSyncedAt = call.startedAt;
        }
      }

      if (hitKnownTerritory) break;
      if (page + 1 >= totalPages) break;
    }

    return { calls: collected, newLastSyncedAt };
  },
};
