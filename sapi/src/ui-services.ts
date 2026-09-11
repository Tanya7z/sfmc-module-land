/** 声明式领地页面使用的高层 service 适配。 */

import { world } from "@minecraft/server";
import { Msg } from "@sfmc-bds/sdk/sapi/runtime";
import { totemBoxFromCore } from "./aabb.js";
import type { LandConfig } from "./config.js";
import { previewColor, showLandHighlight } from "./debug-draw.js";
import { pendingBoxes } from "./pending.js";
import { calcPeriodRent } from "./rent.js";
import {
  findPublicLandByName,
  handleById,
  handleCreateLease,
  handleExpandLease,
  handleGetPerks,
  handleRenewLease,
  handleSetPerk,
  handleTeleport,
  handleTerminateLease,
} from "./services.js";

let configGetter: () => LandConfig = () => {
  throw new Error("领地配置尚未加载");
};

export function bindLandUiConfig(getter: () => LandConfig): void {
  configGetter = getter;
}

function player(input: Record<string, unknown>) {
  const playerId = String(input.playerId ?? "");
  const found = world
    .getAllPlayers()
    .find((candidate) => candidate.id === playerId);
  if (!found) throw new Error("玩家不在线");
  return found;
}

async function ownedLand(input: Record<string, unknown>) {
  const current = player(input);
  const land = await handleById({ id: String(input.landId ?? "") });
  if (!land) throw new Error("领地不存在");
  if (land.ownerId !== current.id) throw new Error("只能管理自己的领地");
  return { current, land };
}

async function detail(input: Record<string, unknown>) {
  const { land } = await ownedLand(input);
  return {
    ...land,
    leaseUntilText: new Date(Number(land.leaseUntil) || 0).toLocaleString(),
    publicText: land.isPublic ? "是" : "否",
    maxLevel: configGetter().totem.max_level,
  };
}

async function renew(input: Record<string, unknown>) {
  const { current, land } = await ownedLand(input);
  const result = await handleRenewLease({
    landId: land.id,
    days: Math.max(1, Math.floor(Number(input.days) || 7)),
    actorId: current.id,
  });
  if (!result.ok) throw new Error(result.error || "续租失败");
  return result;
}

function expansionBox(land: Record<string, unknown>, level: number) {
  const cfg = configGetter();
  const safeLevel = Math.min(
    cfg.totem.max_level,
    Math.max(Number(land.level) || 1, Math.floor(level)),
  );
  const radii = cfg.totem.level_radius;
  const radius = radii[safeLevel - 1] ?? cfg.totem.initial_radius;
  const core = land.core as { x?: number; y?: number; z?: number };
  return {
    level: safeLevel,
    box: totemBoxFromCore(
      { x: Number(core?.x), y: Number(core?.y), z: Number(core?.z) },
      radius,
    ),
  };
}

async function previewExpand(input: Record<string, unknown>) {
  const { current, land } = await ownedLand(input);
  const { level, box } = expansionBox(land, Number(input.level));
  const core = land.core as { x?: number; y?: number; z?: number };
  await showLandHighlight({
    key: `preview:${current.id}`,
    box,
    color: previewColor(),
    label: `§e扩建预览 Lv.${level}`,
    labelAt: { x: Number(core.x), y: Number(core.y) + 3, z: Number(core.z) },
  });
  return { level, message: `已显示 Lv.${level} 扩建预览` };
}

async function expand(input: Record<string, unknown>) {
  const { land } = await ownedLand(input);
  const { box } = expansionBox(land, Number(input.level));
  const result = await handleExpandLease({
    landId: land.id,
    newMin: box.min,
    newMax: box.max,
  });
  if (!result.ok) throw new Error(result.error || "扩建失败");
  return result;
}

async function terminate(input: Record<string, unknown>) {
  const { current, land } = await ownedLand(input);
  const result = await handleTerminateLease({
    landId: land.id,
    playerId: current.id,
  });
  if (!result.ok) throw new Error(result.error || "解除失败");
  return result;
}

async function perks(input: Record<string, unknown>) {
  const { land } = await ownedLand(input);
  const result = await handleGetPerks({ landId: land.id });
  return {
    items: (result.perks as Array<{ perkId: string; enabled: boolean }>).map(
      (perk) => ({
        ...perk,
        statusText: perk.enabled ? "已启用" : "已停用",
        toggleText: perk.enabled ? "停用" : "启用",
      }),
    ),
  };
}

async function togglePerk(input: Record<string, unknown>) {
  const { land } = await ownedLand(input);
  const perkId = String(input.perkId);
  const current = await handleGetPerks({ landId: land.id });
  const enabled = (
    current.perks as Array<{ perkId: string; enabled: boolean }>
  ).find((perk) => perk.perkId === perkId)?.enabled;
  return handleSetPerk({
    landId: land.id,
    perkId,
    enabled: !enabled,
  });
}

function leaseBox(input: Record<string, unknown>) {
  const current = player(input);
  const pending = pendingBoxes.get(current.id);
  if (pending) {
    return { current, pending, box: pending.box, dimension: pending.dimension };
  }
  const location = current.location;
  const cfg = configGetter();
  return {
    current,
    pending: undefined,
    box: totemBoxFromCore(
      {
        x: Math.floor(location.x),
        y: Math.floor(location.y),
        z: Math.floor(location.z),
      },
      cfg.totem.initial_radius,
    ),
    dimension: current.dimension.id,
  };
}

function leaseDraft(input: Record<string, unknown>) {
  const { current, pending } = leaseBox(input);
  return {
    mode: pending ? "精度选点起租" : "基石半径起租",
    description: pending
      ? "使用已缓存的金镐选点盒"
      : "以当前位置为中心，垂直通天初始半径",
    suggestedName: `${current.name}的庄园`,
  };
}

async function previewLease(input: Record<string, unknown>) {
  const { current, box, pending } = leaseBox(input);
  const days = Math.max(1, Math.floor(Number(input.days) || 7));
  await showLandHighlight({
    key: `preview:${current.id}`,
    box,
    color: previewColor(),
    label: pending ? "§e选点预览" : "§e起租预览",
    labelAt: {
      x: (box.min.x + box.max.x) / 2,
      y: box.max.y + 1,
      z: (box.min.z + box.max.z) / 2,
    },
  });
  const estimate = calcPeriodRent(
    configGetter().base_daily_rent,
    days,
    configGetter(),
  );
  return { estimate, message: `预览已显示，参考价约 ${estimate}` };
}

async function createLease(input: Record<string, unknown>) {
  const { current, pending, dimension } = leaseBox(input);
  const days = Math.max(1, Math.floor(Number(input.days) || 7));
  const name = String(input.name || `${current.name}的庄园`);
  const result = pending
    ? await handleCreateLease({
        playerId: current.id,
        dimension,
        days,
        name,
        min: pending.box.min,
        max: pending.box.max,
      })
    : await handleCreateLease({
        playerId: current.id,
        dimension,
        days,
        name,
        isTotem: true,
        core: {
          x: Math.floor(current.location.x),
          y: Math.floor(current.location.y),
          z: Math.floor(current.location.z),
        },
      });
  if (!result.ok) throw new Error(result.error || "起租失败");
  if (pending) pendingBoxes.delete(current.id);
  return result;
}

async function teleportByName(input: Record<string, unknown>) {
  const current = player(input);
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("请输入庄园名称");
  const land = await findPublicLandByName(name);
  if (!land) throw new Error("未找到公开地标");
  const result = await handleTeleport({
    playerId: current.id,
    landId: land.id,
  });
  if (!result.ok) throw new Error(result.error || "传送失败");
  Msg.success(`已传送，门票 ${result.feePaid ?? 0}`, current);
  return result;
}

export const landUiServices: Record<
  string,
  (input: Record<string, unknown>) => unknown | Promise<unknown>
> = {
  "land.ui.detail": detail,
  "land.ui.renew": renew,
  "land.ui.previewExpand": previewExpand,
  "land.ui.expand": expand,
  "land.ui.terminate": terminate,
  "land.ui.perks": perks,
  "land.ui.togglePerk": togglePerk,
  "land.ui.leaseDraft": leaseDraft,
  "land.ui.previewLease": previewLease,
  "land.ui.createLease": createLease,
  "land.ui.teleportByName": teleportByName,
};
