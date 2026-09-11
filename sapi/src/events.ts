/**
 * 世界事件：守护基石放置、右键基石、精度选点、防爆/抑怪等增益拦截。
 */

import { system, world, type Player } from "@minecraft/server";
import { debug, Msg } from "@sfmc-bds/sdk/sapi/runtime";
import { normalizeAabb } from "./aabb.js";
import { cacheFindByPos, cacheHasPerk } from "./cache.js";
import type { LandConfig } from "./config.js";
import { pendingBoxes } from "./pending.js";
import { previewColor, showLandHighlight } from "./debug-draw.js";
import { handleCreateLease } from "./services.js";
import { findLandByPos } from "./store.js";
import { openLandUi } from "./ui.js";

type Selection = {
  a?: { x: number; y: number; z: number };
  dimension?: string;
};

const selections = new Map<string, Selection>();

export { pendingBoxes };

let cfgGetter: () => LandConfig = () => {
  throw new Error("config missing");
};

export function bindEventsConfig(getter: () => LandConfig): void {
  cfgGetter = getter;
}

export function registerLandEvents(cleanups: Array<() => void>): void {
  const placeCb = world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    void onPlaceBlock(
      ev.player,
      ev.block.typeId,
      {
        x: ev.block.location.x,
        y: ev.block.location.y,
        z: ev.block.location.z,
      },
      ev.block.dimension.id,
    );
  });
  cleanups.push(() => {
    try {
      world.afterEvents.playerPlaceBlock.unsubscribe(placeCb);
    } catch {
      /* ignore */
    }
  });

  const interactCb = world.afterEvents.playerInteractWithBlock.subscribe(
    (ev) => {
      void onInteractBlock(
        ev.player,
        ev.block.typeId,
        {
          x: ev.block.location.x,
          y: ev.block.location.y,
          z: ev.block.location.z,
        },
        ev.block.dimension.id,
      );
    },
  );
  cleanups.push(() => {
    try {
      world.afterEvents.playerInteractWithBlock.unsubscribe(interactCb);
    } catch {
      /* ignore */
    }
  });

  // 防爆：必须同步 cancel（beforeEvents 不可 await）
  try {
    const boom = world.beforeEvents.explosion.subscribe((ev) => {
      try {
        const dim = ev.dimension.id;
        const impact = ev.getImpactedBlocks()?.[0]?.location;
        if (!impact) return;
        const hit = cacheFindByPos(dim, impact.x, impact.y, impact.z);
        if (!hit || hit.row.status !== "active") return;
        if (cacheHasPerk(hit, "noboom")) ev.cancel = true;
      } catch {
        /* ignore */
      }
    });
    cleanups.push(() => {
      try {
        world.beforeEvents.explosion.unsubscribe(boom);
      } catch {
        /* ignore */
      }
    });
  } catch (err) {
    debug.w(
      "LandEvents",
      `explosion 订阅失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 抑怪：生成后若在 peace 增益领地则移除
  try {
    const spawnCb = world.afterEvents.entitySpawn.subscribe((ev) => {
      try {
        const e = ev.entity;
        if (!e || e.typeId === "minecraft:player") return;
        if (!isHostile(e.typeId)) return;
        const loc = e.location;
        const hit = cacheFindByPos(e.dimension.id, loc.x, loc.y, loc.z);
        if (!hit || hit.row.status !== "active") return;
        if (cacheHasPerk(hit, "peace")) {
          try {
            e.remove();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    });
    cleanups.push(() => {
      try {
        world.afterEvents.entitySpawn.unsubscribe(spawnCb);
      } catch {
        /* ignore */
      }
    });
  } catch (err) {
    debug.w(
      "LandEvents",
      `entitySpawn 订阅失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function onPlaceBlock(
  player: Player,
  typeId: string,
  loc: { x: number; y: number; z: number },
  dimension: string,
): Promise<void> {
  const cfg = cfgGetter();
  if (typeId !== cfg.totem.item_type) return;

  Msg.info("检测到守护基石，正在校验领地…", player);
  const res = await handleCreateLease({
    playerId: player.id,
    dimension,
    days: 7,
    name: `${player.name}的庄园`,
    isTotem: true,
    core: { x: loc.x, y: loc.y, z: loc.z },
  });
  if (res.ok) {
    Msg.success(`起租成功！契约领地 ${res.landId}`, player);
    void openLandUi(player).catch((error) => {
      debug.w(
        "LandEvents",
        `打开领地 UI 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } else {
    Msg.error(res.error ?? "起租失败", player);
  }
}

async function onInteractBlock(
  player: Player,
  typeId: string,
  loc: { x: number; y: number; z: number },
  dimension: string,
): Promise<void> {
  const cfg = cfgGetter();

  if (typeId === cfg.totem.item_type) {
    const land = await findLandByPos(dimension, loc.x, loc.y, loc.z);
    if (land && land.owner_id === player.id) {
      void openLandUi(player).catch((error) => {
        debug.w(
          "LandEvents",
          `打开领地 UI 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return;
    }
  }

  const inv = player.getComponent("minecraft:inventory");
  const slotIndex =
    typeof (player as { selectedSlotIndex?: number }).selectedSlotIndex ===
    "number"
      ? (player as { selectedSlotIndex: number }).selectedSlotIndex
      : 0;
  const slot = inv?.container?.getItem(slotIndex);
  if (slot?.typeId !== "minecraft:golden_pickaxe") return;

  const sel = selections.get(player.id) ?? {};
  if (!sel.a || sel.dimension !== dimension) {
    selections.set(player.id, { a: loc, dimension });
    Msg.info(
      `已选定点 A (${loc.x},${loc.y},${loc.z})，再点一次设定点 B`,
      player,
    );
    return;
  }

  const box = normalizeAabb({
    min: { x: sel.a.x, y: sel.a.y, z: sel.a.z },
    max: { x: loc.x, y: loc.y, z: loc.z },
  });
  selections.delete(player.id);
  await showLandHighlight({
    key: `preview:${player.id}`,
    box,
    color: previewColor(),
    label: "§e精度选点预览",
    labelAt: {
      x: (box.min.x + box.max.x) / 2,
      y: box.max.y + 1,
      z: (box.min.z + box.max.z) / 2,
    },
  });
  pendingBoxes.set(player.id, { box, dimension });
  Msg.info("预览已挂载。打开 !land 控制台 → 起租向导 确认契约。", player);
  void openLandUi(player, "land.lease").catch((error) => {
    debug.w(
      "LandEvents",
      `打开起租 UI 失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

function isHostile(typeId: string): boolean {
  const hostile = [
    "minecraft:zombie",
    "minecraft:skeleton",
    "minecraft:creeper",
    "minecraft:spider",
    "minecraft:enderman",
    "minecraft:witch",
    "minecraft:phantom",
    "minecraft:drowned",
    "minecraft:husk",
    "minecraft:stray",
    "minecraft:pillager",
    "minecraft:vindicator",
    "minecraft:ravager",
    "minecraft:warden",
  ];
  return (
    hostile.includes(typeId) ||
    typeId.includes("zombie") ||
    typeId.includes("skeleton")
  );
}

/** 供 heal 增益：周期给区域内玩家短暂再生（轻量）。 */
export function startHealTicker(cleanups: Array<() => void>): void {
  const runId = system.runInterval(() => {
    for (const p of world.getAllPlayers()) {
      try {
        const hit = cacheFindByPos(
          p.dimension.id,
          p.location.x,
          p.location.y,
          p.location.z,
        );
        if (!hit || hit.row.status !== "active") continue;
        if (!cacheHasPerk(hit, "heal")) continue;
        p.addEffect("minecraft:regeneration", 40, {
          amplifier: 0,
          showParticles: false,
        });
      } catch {
        /* ignore */
      }
    }
  }, 100);
  cleanups.push(() => {
    try {
      system.clearRun(runId);
    } catch {
      /* ignore */
    }
  });
}
