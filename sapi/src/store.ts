/**
 * land 私有表定义与基础读写。
 */

import { db } from "@sfmc-bds/sdk/sapi/db";
import type { Aabb } from "./types.js";
import type { LandRow, LandStatus, MemberRow, MemberRole, PerkId, PerkRow } from "./types.js";

export const LANDS_TABLE = "sfmc_lands";
export const MEMBERS_TABLE = "sfmc_land_members";
export const PERKS_TABLE = "sfmc_land_perks";
export const GUESTBOOK_TABLE = "sfmc_land_guestbook";
export const OPS_TABLE = "sfmc_land_operations";

export async function defineLandTables(): Promise<void> {
  await db.defineTable(LANDS_TABLE, {
    id: { type: "TEXT", primary: true },
    owner_id: { type: "TEXT", notNull: true, index: true },
    name: { type: "TEXT", default: "" },
    dimension: { type: "TEXT", notNull: true, index: true },
    min_x: { type: "REAL", notNull: true },
    min_y: { type: "REAL", notNull: true },
    min_z: { type: "REAL", notNull: true },
    max_x: { type: "REAL", notNull: true },
    max_y: { type: "REAL", notNull: true },
    max_z: { type: "REAL", notNull: true },
    core_x: { type: "REAL", default: 0 },
    core_y: { type: "REAL", default: 0 },
    core_z: { type: "REAL", default: 0 },
    level: { type: "INTEGER", default: 1 },
    status: { type: "TEXT", notNull: true, index: true },
    daily_rent: { type: "INTEGER", notNull: true, default: 1 },
    lease_until: { type: "INTEGER", notNull: true, index: true },
    grace_until: { type: "INTEGER", default: 0 },
    ticket_price: { type: "INTEGER", default: 0 },
    is_public: { type: "INTEGER", default: 0 },
    likes_count: { type: "INTEGER", default: 0 },
    version: { type: "INTEGER", default: 1 },
    created_at: { type: "INTEGER", notNull: true },
    updated_at: { type: "INTEGER", notNull: true },
  });

  await db.defineTable(MEMBERS_TABLE, {
    id: { type: "TEXT", primary: true },
    land_id: { type: "TEXT", notNull: true, index: true },
    player_id: { type: "TEXT", notNull: true, index: true },
    role: { type: "TEXT", notNull: true, default: "member" },
    permissions_json: { type: "TEXT", default: "{}" },
    updated_at: { type: "INTEGER", notNull: true },
  });

  await db.defineTable(PERKS_TABLE, {
    id: { type: "TEXT", primary: true },
    land_id: { type: "TEXT", notNull: true, index: true },
    perk_id: { type: "TEXT", notNull: true },
    enabled: { type: "INTEGER", default: 0 },
    settings_json: { type: "TEXT", default: "{}" },
  });

  await db.defineTable(GUESTBOOK_TABLE, {
    id: { type: "TEXT", primary: true },
    land_id: { type: "TEXT", notNull: true, index: true },
    visitor_id: { type: "TEXT", default: "" },
    visitor_name: { type: "TEXT", default: "" },
    message: { type: "TEXT", default: "" },
    is_like: { type: "INTEGER", default: 0 },
    created_at: { type: "INTEGER", notNull: true, index: true },
  });

  await db.defineTable(OPS_TABLE, {
    request_id: { type: "TEXT", primary: true },
    operation_type: { type: "TEXT", notNull: true },
    status: { type: "TEXT", notNull: true },
    response_json: { type: "TEXT", default: "{}" },
    created_at: { type: "INTEGER", notNull: true, index: true },
  });
}

export function landToAabb(row: LandRow): Aabb {
  return {
    min: { x: row.min_x, y: row.min_y, z: row.min_z },
    max: { x: row.max_x, y: row.max_y, z: row.max_z },
  };
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function getLandById(id: string): Promise<LandRow | null> {
  const row = await db.get(LANDS_TABLE, id);
  return (row as unknown as LandRow | undefined) ?? null;
}

export async function listLandsByOwner(
  ownerId: string,
  limit = 50,
  offset = 0,
): Promise<LandRow[]> {
  const rows = await db.query(LANDS_TABLE, {
    where: {
      and: [{ eq: ["owner_id", ownerId] }, { ne: ["status", "terminated"] }],
    },
    orderBy: { field: "created_at", dir: "desc" },
    limit,
    offset,
  });
  return rows as unknown as LandRow[];
}

export async function countActiveLandsByOwner(ownerId: string): Promise<number> {
  const rows = await db.query(LANDS_TABLE, {
    where: {
      and: [
        { eq: ["owner_id", ownerId] },
        { in: ["status", ["active", "dormant"]] },
      ],
    },
    limit: 1000,
  });
  return rows.length;
}

/** 同维度全部有效（active|dormant）契约，供 AABB 碰撞。 */
export async function listEffectiveLandsInDimension(dimension: string): Promise<LandRow[]> {
  const rows = await db.query(LANDS_TABLE, {
    where: {
      and: [
        { eq: ["dimension", dimension] },
        { in: ["status", ["active", "dormant"]] },
      ],
    },
    limit: 5000,
  });
  return rows as unknown as LandRow[];
}

export async function findLandByPos(
  dimension: string,
  x: number,
  y: number,
  z: number,
): Promise<LandRow | null> {
  const lands = await listEffectiveLandsInDimension(dimension);
  for (const land of lands) {
    if (
      x >= land.min_x &&
      x <= land.max_x &&
      y >= land.min_y &&
      y <= land.max_y &&
      z >= land.min_z &&
      z <= land.max_z
    ) {
      return land;
    }
  }
  return null;
}

export async function listMembers(landId: string): Promise<MemberRow[]> {
  const rows = await db.query(MEMBERS_TABLE, {
    where: { eq: ["land_id", landId] },
    limit: 500,
  });
  return rows as unknown as MemberRow[];
}

export async function upsertMember(
  landId: string,
  playerId: string,
  role: MemberRole,
  permissions: Record<string, boolean>,
): Promise<void> {
  const existing = await db.query(MEMBERS_TABLE, {
    where: {
      and: [{ eq: ["land_id", landId] }, { eq: ["player_id", playerId] }],
    },
    limit: 1,
  });
  const payload = {
    land_id: landId,
    player_id: playerId,
    role,
    permissions_json: JSON.stringify(permissions),
    updated_at: Date.now(),
  };
  if (existing[0]?.id) {
    await db.update(MEMBERS_TABLE, String(existing[0].id), payload);
  } else {
    await db.insert(MEMBERS_TABLE, { id: makeId("lm"), ...payload });
  }
}

export async function listPerks(landId: string): Promise<PerkRow[]> {
  const rows = await db.query(PERKS_TABLE, {
    where: { eq: ["land_id", landId] },
    limit: 50,
  });
  return rows as unknown as PerkRow[];
}

export async function setPerkEnabled(
  landId: string,
  perkId: PerkId,
  enabled: boolean,
  settings: Record<string, unknown> = {},
): Promise<void> {
  const existing = await db.query(PERKS_TABLE, {
    where: {
      and: [{ eq: ["land_id", landId] }, { eq: ["perk_id", perkId] }],
    },
    limit: 1,
  });
  const payload = {
    land_id: landId,
    perk_id: perkId,
    enabled: enabled ? 1 : 0,
    settings_json: JSON.stringify(settings),
  };
  if (existing[0]?.id) {
    await db.update(PERKS_TABLE, String(existing[0].id), payload);
  } else {
    await db.insert(PERKS_TABLE, { id: makeId("lp"), ...payload });
  }
}

export async function recordOperation(
  requestId: string,
  operationType: string,
  status: string,
  response: Record<string, unknown>,
): Promise<void> {
  await db.insert(OPS_TABLE, {
    request_id: requestId,
    operation_type: operationType,
    status,
    response_json: JSON.stringify(response),
    created_at: Date.now(),
  });
}

export async function updateLandFields(
  id: string,
  fields: Partial<LandRow>,
): Promise<void> {
  await db.update(LANDS_TABLE, id, { ...fields, updated_at: Date.now() });
}

export async function insertLand(row: LandRow): Promise<void> {
  await db.insert(LANDS_TABLE, row as unknown as Record<string, unknown>);
}

export async function listExpiredActive(now: number): Promise<LandRow[]> {
  const rows = await db.query(LANDS_TABLE, {
    where: {
      and: [{ eq: ["status", "active"] }, { lt: ["lease_until", now] }],
    },
    limit: 1000,
  });
  return rows as unknown as LandRow[];
}

export async function listGraceExpired(now: number): Promise<LandRow[]> {
  const rows = await db.query(LANDS_TABLE, {
    where: {
      and: [{ eq: ["status", "dormant"] }, { lt: ["grace_until", now] }],
    },
    limit: 1000,
  });
  return rows as unknown as LandRow[];
}

export function isProtectingStatus(status: LandStatus): boolean {
  return status === "active" || status === "dormant";
}
