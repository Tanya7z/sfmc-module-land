/**
 * land.* 对外服务实现（只租不卖契约核心）。
 */

import type { Player } from "@minecraft/server";
import { world } from "@minecraft/server";
import { ServiceError } from "@sfmc-bds/sdk/sapi/service";
import { aabbIntersects, normalizeAabb, totemBoxFromCore } from "./aabb.js";
import { syncLandArea, unregisterLandArea } from "./area-bridge.js";
import { cacheHasConflict, cacheRemove, cacheUpsert } from "./cache.js";
import type { LandConfig } from "./config.js";
import { clearShapes, colorForViewer, showLandHighlight } from "./debug-draw.js";
import { activityQuery, activityRecord, economyCredit, economyDebit } from "./platform.js";
import {
  calcDailyRent,
  calcPeriodRent,
  expansionFeeDiff,
  mineralToCurrency,
  remainingLeaseDays,
} from "./rent.js";
import {
  countActiveLandsByOwner,
  findLandByPos,
  getLandById,
  insertLand,
  landToAabb,
  listLandsByOwner,
  listEffectiveLandsInDimension,
  listMembers,
  listPerks,
  makeId,
  recordOperation,
  setPerkEnabled,
  updateLandFields,
  upsertMember,
  GUESTBOOK_TABLE,
  LANDS_TABLE,
} from "./store.js";
import { db } from "@sfmc-bds/sdk/sapi/db";
import {
  ALL_PERKS,
  DAY_MS,
  type Aabb,
  type LandRow,
  type PerkId,
} from "./types.js";

async function refreshCache(landId: string): Promise<void> {
  const land = await getLandById(landId);
  if (!land || land.status === "terminated") {
    cacheRemove(landId);
    return;
  }
  const perks = await listPerks(landId);
  cacheUpsert(
    land,
    perks.filter((p) => p.enabled).map((p) => String(p.perk_id)),
  );
}

let cfgRef: () => LandConfig = () => {
  throw new ServiceError("land config 未初始化", "failed_precondition", 503);
};

export function bindLandConfig(getter: () => LandConfig): void {
  cfgRef = getter;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function findPlayer(playerId: string): Player | undefined {
  return world.getAllPlayers().find((p) => p.id === playerId);
}

function parseBox(input: Record<string, unknown>): Aabb {
  const min = input.min as { x?: number; y?: number; z?: number } | undefined;
  const max = input.max as { x?: number; y?: number; z?: number } | undefined;
  if (!min || !max) {
    throw new ServiceError("缺少 min/max", "invalid_argument", 400);
  }
  return normalizeAabb({
    min: { x: asNumber(min.x), y: asNumber(min.y), z: asNumber(min.z) },
    max: { x: asNumber(max.x), y: asNumber(max.y), z: asNumber(max.z) },
  });
}

function rowToPublic(land: LandRow): Record<string, unknown> {
  return {
    id: land.id,
    ownerId: land.owner_id,
    name: land.name,
    dimension: land.dimension,
    min: { x: land.min_x, y: land.min_y, z: land.min_z },
    max: { x: land.max_x, y: land.max_y, z: land.max_z },
    core: { x: land.core_x, y: land.core_y, z: land.core_z },
    level: land.level,
    status: land.status,
    dailyRent: land.daily_rent,
    leaseUntil: land.lease_until,
    graceUntil: land.grace_until,
    ticketPrice: land.ticket_price,
    isPublic: !!land.is_public,
    likesCount: land.likes_count,
    version: land.version,
    createdAt: land.created_at,
    updatedAt: land.updated_at,
  };
}

export async function handleById(input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const id = asString(input.id);
  if (!id) throw new ServiceError("缺少 id", "invalid_argument", 400);
  const land = await getLandById(id);
  return land ? rowToPublic(land) : null;
}

export async function handleByPos(input: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const dimension = asString(input.dimension);
  if (!dimension) throw new ServiceError("缺少 dimension", "invalid_argument", 400);
  const land = await findLandByPos(
    dimension,
    asNumber(input.x),
    asNumber(input.y),
    asNumber(input.z),
  );
  return land ? rowToPublic(land) : null;
}

export async function handleListByOwner(input: Record<string, unknown>): Promise<{ lands: Record<string, unknown>[] }> {
  const ownerId = asString(input.ownerId);
  if (!ownerId) throw new ServiceError("缺少 ownerId", "invalid_argument", 400);
  const lands = await listLandsByOwner(
    ownerId,
    Math.min(100, Math.max(1, asNumber(input.limit, 50))),
    Math.max(0, asNumber(input.offset, 0)),
  );
  return { lands: lands.map(rowToPublic) };
}

export async function handleListMembers(input: Record<string, unknown>): Promise<{ members: unknown[] }> {
  const landId = asString(input.landId);
  if (!landId) throw new ServiceError("缺少 landId", "invalid_argument", 400);
  const members = await listMembers(landId);
  return {
    members: members.map((m) => ({
      landId: m.land_id,
      playerId: m.player_id,
      role: m.role,
      permissions: safeParse(m.permissions_json),
      updatedAt: m.updated_at,
    })),
  };
}

export async function handleGetPlayerRole(
  input: Record<string, unknown>,
): Promise<{ role: string | null; permissions: Record<string, boolean> }> {
  const landId = asString(input.landId);
  const playerId = asString(input.playerId);
  if (!landId || !playerId) throw new ServiceError("缺少 landId/playerId", "invalid_argument", 400);
  const land = await getLandById(landId);
  if (!land) return { role: null, permissions: {} };
  if (land.owner_id === playerId) {
    return { role: "owner", permissions: { ...cfgRef().default_permissions } };
  }
  const members = await listMembers(landId);
  const hit = members.find((m) => m.player_id === playerId);
  if (!hit) return { role: null, permissions: {} };
  return {
    role: hit.role,
    permissions: (safeParse(hit.permissions_json) as Record<string, boolean>) ?? {},
  };
}

export async function handleValidateBox(
  input: Record<string, unknown>,
): Promise<{ valid: boolean; dailyRent: number; conflict?: string }> {
  const dimension = asString(input.dimension);
  if (!dimension) throw new ServiceError("缺少 dimension", "invalid_argument", 400);
  const box = parseBox(input);
  const exclude = asString(input.excludeLandId) || undefined;
  const ownerId = asString(input.ownerId);
  const existingCount = ownerId ? await countActiveLandsByOwner(ownerId) : 0;
  const dailyRent = calcDailyRent(box, cfgRef(), existingCount);

  const others = await listEffectiveLandsInDimension(dimension);
  for (const o of others) {
    if (exclude && o.id === exclude) continue;
    if (aabbIntersects(box, landToAabb(o))) {
      return { valid: false, dailyRent, conflict: o.id };
    }
  }
  // 内存索引双检（启动后新建未刷库前）
  const memConflict = cacheHasConflict(dimension, box, exclude);
  if (memConflict) return { valid: false, dailyRent, conflict: memConflict };
  return { valid: true, dailyRent };
}

export async function handleCreateLease(
  input: Record<string, unknown>,
): Promise<{ ok: boolean; landId?: string; leaseUntil?: number; error?: string }> {
  const playerId = asString(input.playerId);
  const dimension = asString(input.dimension);
  const days = Math.max(1, Math.floor(asNumber(input.days, 7)));
  const name = asString(input.name) || `${playerId}的庄园`;
  if (!playerId || !dimension) {
    throw new ServiceError("缺少 playerId/dimension", "invalid_argument", 400);
  }

  const cfg = cfgRef();
  const existingCount = await countActiveLandsByOwner(playerId);
  if (existingCount >= cfg.max_lands_per_player) {
    return { ok: false, error: "已达个人领地上限" };
  }

  let box: Aabb;
  let core = { x: 0, y: 64, z: 0 };
  let level = 1;
  if (input.isTotem && input.core) {
    const c = input.core as { x: number; y: number; z: number };
    core = { x: asNumber(c.x), y: asNumber(c.y), z: asNumber(c.z) };
    const radius = cfg.totem.level_radius[0] ?? cfg.totem.initial_radius;
    box = totemBoxFromCore(core, radius);
  } else {
    box = parseBox(input);
    core = {
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2,
      z: (box.min.z + box.max.z) / 2,
    };
  }

  const validated = await handleValidateBox({
    dimension,
    min: box.min,
    max: box.max,
    ownerId: playerId,
  });
  if (!validated.valid) {
    return { ok: false, error: `与领地 ${validated.conflict} 重叠` };
  }

  const dailyRent = validated.dailyRent;
  const fee = calcPeriodRent(dailyRent, days, cfg);
  const requestId = makeId("lease");
  const debit = await economyDebit({
    accountId: playerId,
    amount: fee,
    reason: "land.lease",
    actorId: playerId,
    idempotencyKey: requestId,
    referenceType: "land.lease",
    referenceId: requestId,
  });
  if (!debit.ok) {
    await recordOperation(requestId, "lease", "failed", { error: debit.error });
    return { ok: false, error: debit.error ?? "扣款失败" };
  }

  const now = Date.now();
  const leaseUntil = now + days * DAY_MS;
  const landId = makeId("land");
  const row: LandRow = {
    id: landId,
    owner_id: playerId,
    name,
    dimension,
    min_x: box.min.x,
    min_y: box.min.y,
    min_z: box.min.z,
    max_x: box.max.x,
    max_y: box.max.y,
    max_z: box.max.z,
    core_x: core.x,
    core_y: core.y,
    core_z: core.z,
    level,
    status: "active",
    daily_rent: dailyRent,
    lease_until: leaseUntil,
    grace_until: 0,
    ticket_price: 0,
    is_public: 0,
    likes_count: 0,
    version: 1,
    created_at: now,
    updated_at: now,
  };

  try {
    await insertLand(row);
    await upsertMember(landId, playerId, "owner", { ...cfg.default_permissions });
    for (const perk of ALL_PERKS) {
      await setPerkEnabled(landId, perk, false);
    }
    await syncLandArea(row);
    await refreshCache(landId);
    await recordOperation(requestId, "lease", "ok", { landId, fee, leaseUntil });
    await activityRecord({
      eventType: "land.lease_start",
      actorId: playerId,
      targetId: landId,
      dimension,
      x: core.x,
      y: core.y,
      z: core.z,
      payload: { days, fee, dailyRent, name },
    });

    const viewer = findPlayer(playerId);
    void showLandHighlight({
      key: landId,
      box,
      color: colorForViewer(playerId, playerId),
      label: `§a[${name}] §7(契约剩余 ${days}天)`,
      labelAt: { x: core.x, y: core.y + 2, z: core.z },
    });
    if (viewer) {
      /* highlight already keyed by land */
    }
    return { ok: true, landId, leaseUntil };
  } catch (err) {
    // 本地失败：补偿退款
    await economyCredit({
      accountId: playerId,
      amount: fee,
      reason: "land.lease.rollback",
      actorId: playerId,
      idempotencyKey: `${requestId}_rollback`,
      referenceType: "land.lease",
      referenceId: landId,
    });
    await recordOperation(requestId, "lease", "rolled_back", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "创建领地失败，已尝试退款" };
  }
}

export async function handleRenewLease(
  input: Record<string, unknown>,
): Promise<{ ok: boolean; newExpiry?: number; error?: string }> {
  const landId = asString(input.landId);
  const land = landId ? await getLandById(landId) : null;
  if (!land || land.status === "terminated") {
    return { ok: false, error: "领地不存在或已终止" };
  }

  const cfg = cfgRef();
  let days = Math.max(0, Math.floor(asNumber(input.days, 0)));
  let fee = 0;
  const requestId = makeId("renew");

  const mineralItem = input.mineralItem as
    | { typeId?: string; amount?: number }
    | undefined;
  if (mineralItem?.typeId) {
    const currency = mineralToCurrency(
      mineralItem.typeId,
      asNumber(mineralItem.amount, 0),
      cfg.mineral_rates,
    );
    if (currency <= 0) return { ok: false, error: "矿物折算无效" };
    days = Math.max(1, Math.floor(currency / Math.max(1, land.daily_rent)));
    fee = 0; // 矿物路径：由调用方扣除物品；此处只延长租期
  } else {
    days = Math.max(1, days || 7);
    fee = calcPeriodRent(land.daily_rent, days, cfg);
    const debit = await economyDebit({
      accountId: land.owner_id,
      amount: fee,
      reason: "land.renew",
      actorId: asString(input.actorId, land.owner_id),
      idempotencyKey: requestId,
      referenceType: "land.renew",
      referenceId: landId,
    });
    if (!debit.ok) return { ok: false, error: debit.error ?? "扣款失败" };
  }

  const now = Date.now();
  const base = land.status === "dormant" ? now : Math.max(now, land.lease_until);
  const newExpiry = base + days * DAY_MS;
  await updateLandFields(landId, {
    lease_until: newExpiry,
    grace_until: 0,
    status: "active",
  });
  const updated = await getLandById(landId);
  if (updated) await syncLandArea(updated);
  await refreshCache(landId);

  await recordOperation(requestId, "renew", "ok", { landId, days, fee, newExpiry });
  await activityRecord({
    eventType: "land.lease_renew",
    actorId: asString(input.actorId, land.owner_id),
    targetId: landId,
    payload: { days, fee, newExpiry, mineral: !!mineralItem },
  });
  return { ok: true, newExpiry };
}

export async function handleExpandLease(
  input: Record<string, unknown>,
): Promise<{ ok: boolean; feeDiff?: number; error?: string }> {
  const landId = asString(input.landId);
  const land = landId ? await getLandById(landId) : null;
  if (!land || land.status !== "active") {
    return { ok: false, error: "仅 active 契约可扩建" };
  }
  const newBox = parseBox({
    min: input.newMin ?? input.min,
    max: input.newMax ?? input.max,
  });
  const validated = await handleValidateBox({
    dimension: land.dimension,
    min: newBox.min,
    max: newBox.max,
    excludeLandId: landId,
    ownerId: land.owner_id,
  });
  if (!validated.valid) {
    return { ok: false, error: `与领地 ${validated.conflict} 重叠` };
  }

  const rem = remainingLeaseDays(land.lease_until);
  // 扩建日租金按「当前持有数-1」估算倍率，避免把自己算进下一档
  const existingCount = Math.max(0, (await countActiveLandsByOwner(land.owner_id)) - 1);
  const newDaily = calcDailyRent(newBox, cfgRef(), existingCount);
  const feeDiff = expansionFeeDiff(land.daily_rent, newDaily, rem);
  const requestId = makeId("expand");

  if (feeDiff > 0) {
    const debit = await economyDebit({
      accountId: land.owner_id,
      amount: feeDiff,
      reason: "land.expand",
      actorId: land.owner_id,
      idempotencyKey: requestId,
      referenceType: "land.expand",
      referenceId: landId,
    });
    if (!debit.ok) return { ok: false, error: debit.error ?? "扣款失败" };
  }

  const level = inferLevelFromBox(newBox, cfgRef());
  await updateLandFields(landId, {
    min_x: newBox.min.x,
    min_y: newBox.min.y,
    min_z: newBox.min.z,
    max_x: newBox.max.x,
    max_y: newBox.max.y,
    max_z: newBox.max.z,
    daily_rent: newDaily,
    level,
    version: land.version + 1,
  });
  const updated = await getLandById(landId);
  if (updated) {
    await syncLandArea(updated);
    await refreshCache(landId);
    void showLandHighlight({
      key: landId,
      box: newBox,
      color: colorForViewer(land.owner_id, land.owner_id),
      label: `§a[${updated.name} Lv.${level}]`,
      labelAt: { x: updated.core_x, y: updated.core_y + 2, z: updated.core_z },
    });
  }
  await recordOperation(requestId, "expand", "ok", { landId, feeDiff, newDaily });
  await activityRecord({
    eventType: "land.expand",
    actorId: land.owner_id,
    targetId: landId,
    payload: { feeDiff, newDaily, remainingDays: rem },
  });
  return { ok: true, feeDiff };
}

export async function handleTerminateLease(
  input: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const landId = asString(input.landId);
  const playerId = asString(input.playerId);
  const land = landId ? await getLandById(landId) : null;
  if (!land) return { ok: false, error: "领地不存在" };
  if (land.owner_id !== playerId) {
    // 允许 admin 强制：由上层鉴权；此处仅校验非空
    if (!asString(input.forceAdmin)) {
      return { ok: false, error: "仅主人可解除契约" };
    }
  }
  await updateLandFields(landId, { status: "terminated", grace_until: 0 });
  await unregisterLandArea(landId);
  cacheRemove(landId);
  clearShapes(landId);
  await recordOperation(makeId("disband"), "disband", "ok", { landId });
  await activityRecord({
    eventType: "land.lease_terminated",
    actorId: playerId,
    targetId: landId,
    payload: { reason: "manual" },
  });
  return { ok: true };
}

export async function handleTeleport(
  input: Record<string, unknown>,
): Promise<{ ok: boolean; feePaid?: number; error?: string }> {
  const playerId = asString(input.playerId);
  const landId = asString(input.landId);
  const land = landId ? await getLandById(landId) : null;
  if (!land || land.status !== "active" || !land.is_public) {
    return { ok: false, error: "地标未公开或契约非 active" };
  }
  const player = findPlayer(playerId);
  if (!player) return { ok: false, error: "玩家不在线" };

  const fee = Math.max(0, land.ticket_price);
  const requestId = makeId("ticket");
  if (fee > 0 && playerId !== land.owner_id) {
    const debit = await economyDebit({
      accountId: playerId,
      amount: fee,
      reason: "land.ticket",
      actorId: playerId,
      idempotencyKey: requestId,
      referenceType: "land.ticket",
      referenceId: landId,
    });
    if (!debit.ok) return { ok: false, error: debit.error ?? "门票扣款失败" };

    const credit = await economyCredit({
      accountId: land.owner_id,
      amount: fee,
      reason: "land.ticket.income",
      actorId: playerId,
      idempotencyKey: `${requestId}_credit`,
      referenceType: "land.ticket",
      referenceId: landId,
    });
    if (!credit.ok) {
      // 补偿退款，避免吞款
      await economyCredit({
        accountId: playerId,
        amount: fee,
        reason: "land.ticket.rollback",
        actorId: playerId,
        idempotencyKey: `${requestId}_rollback`,
        referenceType: "land.ticket",
        referenceId: landId,
      });
      return { ok: false, error: "门票入账失败，已退款" };
    }
  }

  try {
    const dim = world.getDimension(land.dimension);
    player.teleport(
      { x: land.core_x + 0.5, y: land.core_y + 1, z: land.core_z + 0.5 },
      { dimension: dim },
    );
    try {
      player.onScreenDisplay.setTitle(`§a欢迎来到 ${land.name}`);
    } catch {
      /* ignore */
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  await recordOperation(requestId, "ticket", "ok", { landId, fee, playerId });
  await activityRecord({
    eventType: "land.ticket",
    actorId: playerId,
    targetId: landId,
    payload: { fee },
  });
  return { ok: true, feePaid: fee };
}

export async function handleLeaseStatus(
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const landId = asString(input.landId);
  const land = landId ? await getLandById(landId) : null;
  if (!land) throw new ServiceError("领地不存在", "not_found", 404);
  return {
    remainingDays: remainingLeaseDays(land.lease_until),
    dailyRent: land.daily_rent,
    status: land.status,
    isGracePeriod: land.status === "dormant",
    leaseUntil: land.lease_until,
    graceUntil: land.grace_until,
  };
}

export async function handleGetPerks(
  input: Record<string, unknown>,
): Promise<{ perks: unknown[] }> {
  const landId = asString(input.landId);
  if (!landId) throw new ServiceError("缺少 landId", "invalid_argument", 400);
  const perks = await listPerks(landId);
  return {
    perks: perks.map((p) => ({
      perkId: p.perk_id,
      enabled: !!p.enabled,
      settings: safeParse(p.settings_json),
    })),
  };
}

export async function handleSetPerk(
  input: Record<string, unknown>,
): Promise<{ perks: unknown[] }> {
  const landId = asString(input.landId);
  const perkId = asString(input.perkId) as PerkId;
  if (!landId || !ALL_PERKS.includes(perkId)) {
    throw new ServiceError("无效 landId/perkId", "invalid_argument", 400);
  }
  const land = await getLandById(landId);
  if (!land) throw new ServiceError("领地不存在", "not_found", 404);
  await setPerkEnabled(landId, perkId, !!input.enabled, (input.settings as Record<string, unknown>) ?? {});
  const updated = await getLandById(landId);
  if (updated) await syncLandArea(updated);
  await refreshCache(landId);
  return handleGetPerks({ landId });
}

export async function handleGuestbookList(
  input: Record<string, unknown>,
): Promise<{ entries: unknown[] }> {
  const landId = asString(input.landId);
  if (!landId) throw new ServiceError("缺少 landId", "invalid_argument", 400);
  const rows = await db.query(GUESTBOOK_TABLE, {
    where: { eq: ["land_id", landId] },
    orderBy: { field: "created_at", dir: "desc" },
    limit: Math.min(100, Math.max(1, asNumber(input.limit, 20))),
  });
  return {
    entries: rows.map((r) => ({
      id: r.id,
      visitorId: r.visitor_id,
      visitorName: r.visitor_name,
      message: r.message,
      isLike: !!r.is_like,
      createdAt: r.created_at,
    })),
  };
}

export async function handleGuestbookSign(
  input: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const landId = asString(input.landId);
  const land = landId ? await getLandById(landId) : null;
  if (!land) throw new ServiceError("领地不存在", "not_found", 404);
  const isLike = !!input.isLike;
  await db.insert(GUESTBOOK_TABLE, {
    id: makeId("gb"),
    land_id: landId,
    visitor_id: asString(input.visitorId),
    visitor_name: asString(input.visitorName),
    message: asString(input.message),
    is_like: isLike ? 1 : 0,
    created_at: Date.now(),
  });
  if (isLike) {
    await updateLandFields(landId, { likes_count: land.likes_count + 1 });
  }
  return { ok: true };
}

export async function handleAuditLog(
  input: Record<string, unknown>,
): Promise<{ records: unknown[]; total: number }> {
  const landId = asString(input.landId);
  if (!landId) throw new ServiceError("缺少 landId", "invalid_argument", 400);
  return activityQuery({
    targetId: landId,
    eventTypePrefix: "land.",
    limit: asNumber(input.limit, 50),
    offset: asNumber(input.offset, 0),
  });
}

function inferLevelFromBox(box: Aabb, cfg: LandConfig): number {
  const half = Math.max(
    Math.abs(box.max.x - box.min.x) / 2,
    Math.abs(box.max.z - box.min.z) / 2,
  );
  const radii = cfg.totem.level_radius;
  let level = 1;
  for (let i = 0; i < radii.length; i++) {
    if (half + 0.01 >= (radii[i] ?? 0)) level = i + 1;
  }
  return Math.min(cfg.totem.max_level, level);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

/** 按名称查找公开领地（命令 !land tp 用）。 */
export async function findPublicLandByName(name: string): Promise<LandRow | null> {
  const rows = await db.query(LANDS_TABLE, {
    where: {
      and: [
        { eq: ["name", name] },
        { eq: ["is_public", 1] },
        { eq: ["status", "active"] },
      ],
    },
    limit: 1,
  });
  return (rows[0] as unknown as LandRow | undefined) ?? null;
}
