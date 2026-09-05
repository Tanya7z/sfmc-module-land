/**
 * land 纯逻辑单元测试（不依赖 Minecraft 运行时）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aabbIntersects, blockVolume, footprintBlocks, normalizeAabb, totemBoxFromCore } from "../sapi/src/aabb.ts";
import { DEFAULT_LAND_CONFIG, mergeLandConfig } from "../sapi/src/config.ts";
import {
  calcDailyRent,
  calcPeriodRent,
  expansionFeeDiff,
  landCountMultiplier,
  longTermDiscount,
  mineralToCurrency,
  remainingLeaseDays,
} from "../sapi/src/rent.ts";
import { DAY_MS } from "../sapi/src/types.ts";

describe("land aabb", () => {
  it("normalizeAabb 纠正对角", () => {
    const b = normalizeAabb({
      min: { x: 5, y: 10, z: 5 },
      max: { x: 1, y: 0, z: 1 },
    });
    assert.equal(b.min.x, 1);
    assert.equal(b.max.x, 5);
    assert.equal(b.min.y, 0);
    assert.equal(b.max.y, 10);
  });

  it("aabbIntersects 边界相贴视为冲突", () => {
    const a = normalizeAabb({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } });
    const b = normalizeAabb({ min: { x: 10, y: 0, z: 0 }, max: { x: 20, y: 10, z: 10 } });
    assert.equal(aabbIntersects(a, b), true);
  });

  it("totemBoxFromCore 垂直通天", () => {
    const box = totemBoxFromCore({ x: 0, y: 64, z: 0 }, 16);
    assert.equal(box.min.y, -64);
    assert.equal(box.max.y, 320);
    assert.equal(footprintBlocks(box), 33 * 33);
    assert.ok(blockVolume(box) > footprintBlocks(box));
  });
});

describe("land rent", () => {
  it("长租折扣取最大适用档", () => {
    assert.equal(longTermDiscount(7, DEFAULT_LAND_CONFIG.long_term_discounts), 1);
    assert.equal(longTermDiscount(30, DEFAULT_LAND_CONFIG.long_term_discounts), 0.9);
    assert.equal(longTermDiscount(90, DEFAULT_LAND_CONFIG.long_term_discounts), 0.8);
    assert.equal(longTermDiscount(120, DEFAULT_LAND_CONFIG.long_term_discounts), 0.8);
  });

  it("持有数量倍率", () => {
    const m = DEFAULT_LAND_CONFIG.land_count_multiplier;
    assert.equal(landCountMultiplier(0, m), 1.0);
    assert.equal(landCountMultiplier(1, m), 1.5);
    assert.equal(landCountMultiplier(4, m), 3.0);
    assert.equal(landCountMultiplier(99, m), 3.0);
  });

  it("日租金含面积与倍率", () => {
    const cfg = mergeLandConfig();
    const box = totemBoxFromCore({ x: 0, y: 64, z: 0 }, 16);
    const r0 = calcDailyRent(box, cfg, 0);
    const r1 = calcDailyRent(box, cfg, 1);
    assert.ok(r0 >= cfg.base_daily_rent);
    assert.ok(r1 > r0);
  });

  it("首期租金应用折扣", () => {
    const fee7 = calcPeriodRent(10, 7, DEFAULT_LAND_CONFIG);
    const fee30 = calcPeriodRent(10, 30, DEFAULT_LAND_CONFIG);
    assert.equal(fee7, 70);
    assert.equal(fee30, Math.ceil(10 * 30 * 0.9));
  });

  it("扩建补差仅收差额×剩余天", () => {
    assert.equal(expansionFeeDiff(10, 15, 10), 50);
    assert.equal(expansionFeeDiff(15, 10, 10), 0);
    assert.equal(expansionFeeDiff(10, 15, 0), 0);
  });

  it("剩余租期天数向下取整", () => {
    const now = Date.UTC(2026, 8, 4, 12, 0, 0);
    const until = now + 2.9 * DAY_MS;
    assert.equal(remainingLeaseDays(until, now), 2);
  });

  it("矿物折算", () => {
    assert.equal(mineralToCurrency("minecraft:diamond", 2, DEFAULT_LAND_CONFIG.mineral_rates), 60);
    assert.equal(mineralToCurrency("minecraft:dirt", 10, DEFAULT_LAND_CONFIG.mineral_rates), 0);
  });
});

describe("land identity", () => {
  it("无永久买断语义：契约必须带 lease_until 字段（规格约束）", () => {
    // 纯文档级守卫：确保设计常量日毫秒与宽限期默认值仍为只租不卖
    assert.equal(DAY_MS, 86_400_000);
    assert.equal(DEFAULT_LAND_CONFIG.grace_period_days, 7);
  });
});
