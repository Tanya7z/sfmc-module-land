/**
 * 欠租休眠 / 宽限期终止状态机（小时级扫描）。
 */

import { world } from "@minecraft/server";
import { debug, Msg } from "@sfmc-bds/sdk/sapi/runtime";
import { syncLandArea, unregisterLandArea } from "./area-bridge.js";
import { cacheRemove, cacheUpsert } from "./cache.js";
import type { LandConfig } from "./config.js";
import { clearShapes } from "./debug-draw.js";
import { activityRecord } from "./platform.js";
import {
  getLandById,
  listExpiredActive,
  listGraceExpired,
  listPerks,
  updateLandFields,
} from "./store.js";
import { DAY_MS } from "./types.js";

export async function runLeaseScan(cfg: LandConfig): Promise<{
  dormant: number;
  terminated: number;
}> {
  const now = Date.now();
  let dormant = 0;
  let terminated = 0;

  const expired = await listExpiredActive(now);
  for (const land of expired) {
    const graceUntil = now + cfg.grace_period_days * DAY_MS;
    await updateLandFields(land.id, {
      status: "dormant",
      grace_until: graceUntil,
    });
    const updated = await getLandById(land.id);
    if (updated) {
      await syncLandArea(updated);
      const perks = await listPerks(land.id);
      cacheUpsert(
        updated,
        perks.filter((p) => p.enabled).map((p) => String(p.perk_id)),
      );
    }
    dormant++;

    await activityRecord({
      eventType: "land.lease_dormant",
      actorId: land.owner_id,
      targetId: land.id,
      payload: { graceUntil },
    });

    for (const p of world.getAllPlayers()) {
      if (p.id === land.owner_id) {
        Msg.warning(
          `庄园「${land.name}」已欠租进入 ${cfg.grace_period_days} 天休眠保护，请尽快续租！`,
          p,
        );
      }
    }
  }

  const graceDone = await listGraceExpired(now);
  for (const land of graceDone) {
    await updateLandFields(land.id, { status: "terminated" });
    await unregisterLandArea(land.id);
    cacheRemove(land.id);
    clearShapes(land.id);
    terminated++;
    await activityRecord({
      eventType: "land.lease_terminated",
      actorId: "system",
      targetId: land.id,
      payload: { reason: "grace_expired" },
    });
    debug.i("LandScan", `terminated ${land.id} (${land.name})`);
  }

  return { dormant, terminated };
}
