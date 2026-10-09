// WithAllo adapter: one page of one line, or an error. Everything about how far to walk (cursor,
// lookback, page cap, backfill) is provider-agnostic and lives in lib/sync/.

import { fetchAlloPage } from "./client";
import type { PollableCallProvider, ProviderPage } from "../types";

export const alloProvider: PollableCallProvider = {
  slug: "allo",

  async fetchPage(externalNumber: string, page: number): Promise<ProviderPage> {
    const apiKey = process.env.ALLO_API_KEY ?? "";
    if (!apiKey) throw new Error("ALLO_API_KEY not set");

    const { calls, totalPages, httpOk, httpStatus } = await fetchAlloPage(apiKey, externalNumber, page);
    if (!httpOk) {
      // Never let an error look like an empty page — that would end the walk early and the
      // caller would advance the cursor past calls it never saw.
      throw new Error(`Allo API error status=${httpStatus} line=${externalNumber} page=${page}`);
    }
    return { calls, totalPages };
  },
};
