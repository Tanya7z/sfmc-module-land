/**
 * 有效契约内存索引：供 beforeEvents 同步碰撞/增益判定。
 */

import type { LandRow, PerkId } from "./types.js";
import { landToAabb } from "./store.js";
import { aabbIntersects, pointInAabb } from "./aabb.js";
import type { Aabb } from "./types.js";

export interface CachedLand {
  row: LandRow;
  perks: Set<string>;
}

const byId = new Map<string, CachedLand>();

export function cacheUpsert(row: LandRow, enabledPerks: string[] = []): void {
  if (row.status === "terminated") {
    byId.delete(row.id);
    return;
  }
  byId.set(row.id, { row, perks: new Set(enabledPerks) });
}

export function cacheRemove(landId: string): void {
  byId.delete(landId);
}

export function cacheClear(): void {
  byId.clear();
}

export function cacheAll(): CachedLand[] {
  return [...byId.values()];
}

export function cacheFindByPos(
  dimension: string,
  x: number,
  y: number,
  z: number,
): CachedLand | null {
  for (const c of byId.values()) {
    if (c.row.dimension !== dimension) continue;
    if (c.row.status === "terminated") continue;
    if (pointInAabb({ x, y, z }, landToAabb(c.row))) return c;
  }
  return null;
}

export function cacheHasConflict(
  dimension: string,
  box: Aabb,
  excludeLandId?: string,
): string | undefined {
  for (const c of byId.values()) {
    if (c.row.dimension !== dimension) continue;
    if (c.row.status === "terminated") continue;
    if (excludeLandId && c.row.id === excludeLandId) continue;
    if (aabbIntersects(box, landToAabb(c.row))) return c.row.id;
  }
  return undefined;
}

export function cacheHasPerk(land: CachedLand, perk: PerkId): boolean {
  return land.perks.has(perk);
}
