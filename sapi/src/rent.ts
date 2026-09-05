/**
 * 日租金、长租折扣、扩建补差与矿物折算（纯逻辑）。
 */

import { footprintBlocks } from "./aabb.js";
import type { LandConfig } from "./config.js";
import { DAY_MS, type Aabb } from "./types.js";

/** 按占地面积计算基础日租金（未乘持有数量倍率）。 */
export function calcBaseDailyRent(box: Aabb, cfg: LandConfig): number {
  const blocks = footprintBlocks(box);
  const areaFee = Math.ceil((blocks / 100) * cfg.rent_per_100_blocks);
  return Math.max(1, Math.ceil(cfg.base_daily_rent + areaFee));
}

/**
 * 持有数量倍率：第 1 块用 multipliers[0]，第 2 块用 [1]…
 * existingCount 为创建前已有有效契约数。
 */
export function landCountMultiplier(existingCount: number, multipliers: number[]): number {
  if (multipliers.length === 0) return 1;
  const idx = Math.min(Math.max(0, existingCount), multipliers.length - 1);
  return multipliers[idx] ?? 1;
}

export function calcDailyRent(
  box: Aabb,
  cfg: LandConfig,
  existingLandCount: number,
): number {
  const base = calcBaseDailyRent(box, cfg);
  const mult = landCountMultiplier(existingLandCount, cfg.land_count_multiplier);
  return Math.max(1, Math.ceil(base * mult));
}

/** 长租折扣：取不超过 days 的最大档位。 */
export function longTermDiscount(days: number, discounts: Record<string, number>): number {
  let best = 1;
  let bestDays = 0;
  for (const [k, v] of Object.entries(discounts)) {
    const d = Number(k);
    if (!Number.isFinite(d) || d <= 0) continue;
    if (days >= d && d >= bestDays) {
      bestDays = d;
      best = typeof v === "number" && v > 0 && v <= 1 ? v : 1;
    }
  }
  return best;
}

/** 首期/续租应付总额（日租金 × 天数 × 折扣，向上取整）。 */
export function calcPeriodRent(dailyRent: number, days: number, cfg: LandConfig): number {
  const d = Math.max(1, Math.floor(days));
  const discount = longTermDiscount(d, cfg.long_term_discounts);
  return Math.max(1, Math.ceil(dailyRent * d * discount));
}

/** 剩余有效租期天数（向下取整，至少 0）。 */
export function remainingLeaseDays(leaseUntil: number, now = Date.now()): number {
  return Math.max(0, Math.floor((leaseUntil - now) / DAY_MS));
}

/**
 * 扩建平滑补差：(R_new - R_old) × D_rem。
 * 缩小时费用为 0（不退款）。
 */
export function expansionFeeDiff(
  oldDaily: number,
  newDaily: number,
  remainingDays: number,
): number {
  const rem = Math.max(0, Math.floor(remainingDays));
  const delta = newDaily - oldDaily;
  if (delta <= 0 || rem <= 0) return 0;
  return Math.ceil(delta * rem);
}

/** 矿物折算为节操币（向下取整）。 */
export function mineralToCurrency(
  itemType: string,
  amount: number,
  rates: Record<string, number>,
): number {
  const rate = rates[itemType];
  if (typeof rate !== "number" || rate <= 0) return 0;
  const qty = Math.max(0, Math.floor(amount));
  return Math.floor(qty * rate);
}

/** 按应付金额推算续租天数（忽略长租折扣近似；实际续租仍走货币路径优先）。 */
export function daysAffordable(dailyRent: number, currency: number): number {
  if (dailyRent <= 0 || currency <= 0) return 0;
  return Math.floor(currency / dailyRent);
}
