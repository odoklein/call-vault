// Pulls what the vault needs from the CRM (read-only, via lib/crm/source.ts) to link calls to people:
//  1. SDR -> Allo number (User.alloPhoneNumber): sets Line.crmUserId, and auto-provisions a Line
//     for any SDR number the vault isn't syncing yet. Before this, an SDR whose number wasn't in
//     ALLO_NUMBERS had every call silently missed.
//  2. CALL actions (Action.channel = CALL) with their candidate phones, mirrored into CrmAction
//     for the matcher. Incremental by a log-time watermark with an overlap, so edits made shortly
//     after logging (contact attached, phone fixed) are picked up.

import type { MatchStatus } from "@prisma/client";
import { prisma } from "../db";
import { phonesFromJson, toE164, toE164List } from "../phone";
import type { CrmCallActionRow, CrmSdrNumberRow } from "./queries";
import type { CrmSource } from "./source";

// ---------------------------------------------------------------------------------------------
// SDR lines
// ---------------------------------------------------------------------------------------------

export interface SdrOwner {
  userId: string;
  isActive: boolean;
}

/**
 * Number -> owning SDR. When several users hold the same number, an active user wins over
 * inactive ones (number reassigned after someone left); several active users is a data error —
 * reported, and the number stays unowned rather than guessed.
 */
export function sdrOwnership(rows: CrmSdrNumberRow[]): { owners: Map<string, SdrOwner>; conflicts: string[] } {
  const byNumber = new Map<string, SdrOwner[]>();
  for (const row of rows) {
    const e164 = toE164(row.alloPhoneNumber);
    if (!e164) continue;
    byNumber.set(e164, [...(byNumber.get(e164) ?? []), { userId: row.id, isActive: row.isActive }]);
  }

  const owners = new Map<string, SdrOwner>();
  const conflicts: string[] = [];
  for (const [number, users] of byNumber) {
    const active = users.filter((u) => u.isActive);
    if (active.length > 1) conflicts.push(number);
    else if (active.length === 1) owners.set(number, active[0]);
    else if (users.length === 1) owners.set(number, users[0]);
    else conflicts.push(number);
  }
  return { owners, conflicts };
}

export interface SdrLineSyncResult {
  mapped: number;
  provisioned: string[];
  deactivated: string[];
  conflicts: string[];
}

export async function syncSdrLines(source: CrmSource): Promise<SdrLineSyncResult> {
  const result: SdrLineSyncResult = { mapped: 0, provisioned: [], deactivated: [], conflicts: [] };
  const allo = await prisma.provider.findUnique({ where: { slug: "allo" } });
  if (!allo) return result;

  const rows = await source.sdrNumbers();
  const { owners, conflicts } = sdrOwnership(rows);
  result.conflicts = conflicts;

  const lines = await prisma.line.findMany({ where: { providerId: allo.id } });
  const known = new Set<string>();

  for (const line of lines) {
    const e164 = toE164(line.externalNumber);
    if (e164) known.add(e164);
    const owner = e164 ? owners.get(e164) : undefined;
    const data: { crmUserId?: string | null; isActive?: boolean } = {};

    if ((owner?.userId ?? null) !== line.crmUserId) data.crmUserId = owner?.userId ?? null;
    // Only lines this sync created are switched on/off by it; ALLO_NUMBERS lines stay ops-owned.
    if (line.source === "crm" && !owner && line.isActive) {
      data.isActive = false;
      result.deactivated.push(line.externalNumber);
    }
    if (line.source === "crm" && owner?.isActive && !line.isActive) data.isActive = true;

    if (Object.keys(data).length > 0) await prisma.line.update({ where: { id: line.id }, data });
    if (owner) result.mapped += 1;
  }

  if (process.env.CRM_AUTO_PROVISION_LINES !== "false") {
    for (const [number, owner] of owners) {
      if (known.has(number) || !owner.isActive) continue;
      await prisma.line.create({
        data: { providerId: allo.id, externalNumber: number, crmUserId: owner.userId, source: "crm", isActive: true },
      });
      result.provisioned.push(number);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------------------------
// CALL actions
// ---------------------------------------------------------------------------------------------

const WATERMARK_KEY = "crm.actions.watermark";
const OVERLAP_MS = 6 * 3600_000;
const BATCH = 1000;

export interface CrmActionData {
  sdrUserId: string;
  contactId: string | null;
  companyId: string | null;
  campaignId: string;
  missionId: string;
  clientId: string;
  result: string;
  loggedAt: Date;
  phones: string[];
}

export function crmActionData(row: CrmCallActionRow): CrmActionData {
  return {
    sdrUserId: row.sdrId,
    contactId: row.contactId,
    companyId: row.companyId,
    campaignId: row.campaignId,
    missionId: row.missionId,
    clientId: row.clientId,
    result: row.result,
    loggedAt: new Date(row.loggedAt),
    // Order = preference when a human reads it: the number the meeting was booked on, the
    // contact's own numbers, then the company switchboard.
    phones: toE164List([
      row.meetingPhone,
      row.contactPhone,
      ...phonesFromJson(row.contactAdditionalPhones),
      row.companyPhone,
      ...phonesFromJson(row.companyCustomData),
    ]),
  };
}

interface ExistingAction extends CrmActionData {
  matchStatus: MatchStatus;
}

function samePhones(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** What to write for one mirrored action, or null if nothing changed. */
export function actionUpsertPlan(
  existing: ExistingAction | null,
  data: CrmActionData,
): { kind: "create" | "update"; data: CrmActionData & { matchStatus?: MatchStatus } } | null {
  const statusFor = (phones: string[]): MatchStatus => (phones.length ? "PENDING" : "NO_PHONE");
  if (!existing) return { kind: "create", data: { ...data, matchStatus: statusFor(data.phones) } };

  const phonesChanged = !samePhones(existing.phones, data.phones);
  const changed =
    phonesChanged ||
    existing.contactId !== data.contactId ||
    existing.companyId !== data.companyId ||
    existing.result !== data.result ||
    existing.campaignId !== data.campaignId ||
    existing.missionId !== data.missionId ||
    existing.clientId !== data.clientId ||
    existing.sdrUserId !== data.sdrUserId;
  if (!changed) return null;

  // A match, once made, survives CRM edits; unmatched actions get another chance on new phones.
  const matchStatus = existing.matchStatus !== "MATCHED" && phonesChanged ? statusFor(data.phones) : undefined;
  return { kind: "update", data: { ...data, ...(matchStatus ? { matchStatus } : {}) } };
}

export interface ActionSyncResult {
  read: number;
  created: number;
  updated: number;
  watermark: string;
}

export async function syncCrmActions(source: CrmSource): Promise<ActionSyncResult> {
  const state = await prisma.syncState.findUnique({ where: { key: WATERMARK_KEY } });
  const stored = (state?.value as { loggedAt?: string } | null)?.loggedAt;
  const initialDays = Math.max(1, parseInt(process.env.CRM_ACTIONS_INITIAL_DAYS ?? "35", 10) || 35);
  const watermark = stored ? new Date(stored) : new Date(Date.now() - initialDays * 86_400_000);

  let sinceIso = new Date(watermark.getTime() - (stored ? OVERLAP_MS : 0)).toISOString();
  let afterId = "";
  let newest = watermark;
  const result: ActionSyncResult = { read: 0, created: 0, updated: 0, watermark: watermark.toISOString() };

  for (;;) {
    const rows = await source.callActions(sinceIso, afterId, BATCH);
    if (rows.length === 0) break;
    result.read += rows.length;

    const existing = await prisma.crmAction.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const byId = new Map(existing.map((e) => [e.id, e]));

    for (const row of rows) {
      const data = crmActionData(row);
      const plan = actionUpsertPlan(byId.get(row.id) ?? null, data);
      if (plan?.kind === "create") {
        await prisma.crmAction.create({ data: { id: row.id, ...plan.data } });
        result.created += 1;
      } else if (plan?.kind === "update") {
        await prisma.crmAction.update({ where: { id: row.id }, data: plan.data });
        result.updated += 1;
      }
      if (data.loggedAt > newest) newest = data.loggedAt;
    }

    const last = rows[rows.length - 1];
    sinceIso = last.loggedAt;
    afterId = last.id;
    if (rows.length < BATCH) break;
  }

  result.watermark = newest.toISOString();
  await prisma.syncState.upsert({
    where: { key: WATERMARK_KEY },
    create: { key: WATERMARK_KEY, value: { loggedAt: result.watermark } },
    update: { value: { loggedAt: result.watermark } },
  });
  return result;
}
