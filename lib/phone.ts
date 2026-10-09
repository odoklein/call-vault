// One canonical phone format for the whole vault: E.164 ("+33612345678"). Every number that enters
// the vault (provider from/to, CRM contact/company/meeting phones, SDR Allo numbers) goes through
// toE164() once, at write time, so matching is plain equality on an indexed column instead of the
// substring `contains` scan /api/calls started with. Same library + default country as the CRM's
// lib/call-enrichment/enrich-action.ts normalizePhone, so both sides agree on what "the same
// number" means.

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

const DEFAULT_COUNTRY = (process.env.PHONE_DEFAULT_COUNTRY || "FR").toUpperCase() as CountryCode;

/** E.164 for anything that parses as a phone number, null for empty/garbage input. */
export function toE164(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // "0033…" international prefix and "33…" without plus both show up in CRM free text.
  s = s.replace(/^\(?00/, "+");
  const digits = s.replace(/\D/g, "");
  if (!s.startsWith("+") && digits.length === 11 && digits.startsWith("33")) s = `+${digits}`;

  const parsed = parsePhoneNumberFromString(s, DEFAULT_COUNTRY);
  if (!parsed || !parsed.isPossible()) return null;
  return parsed.number;
}

/** Normalizes and de-duplicates a list of candidate numbers, dropping anything unparseable. */
export function toE164List(raws: Iterable<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const raw of raws) {
    const e164 = toE164(raw);
    if (e164) out.add(e164);
  }
  return [...out];
}

/**
 * Phone strings out of the CRM's Json columns (Contact.additionalPhones, Company.customData's
 * phones/additionalPhones/phoneNumbers). Shapes seen in the wild: ["+33 6 …"], [{ number: "…" }],
 * [{ phone: "…" }], a bare string.
 */
export function phonesFromJson(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const v = o.number ?? o.phone ?? o.value;
        return typeof v === "string" ? [v] : [];
      }
      return [];
    });
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return [o.additionalPhones, o.phones, o.phoneNumbers].flatMap(phonesFromJson);
  }
  return [];
}
