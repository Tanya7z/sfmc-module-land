/**
 * @sfmc-bds/module-land — 土地租赁契约（只租不卖）与庄园生态
 */

import { Player, system } from "@minecraft/server";
import { ModuleRegistry } from "@sfmc-bds/sdk/module-loader";
import { config } from "@sfmc-bds/sdk/sapi/config";
import { Command, Msg, Permission, debug } from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { ensureLandAreaFeatures, syncLandArea } from "./area-bridge.js";
import { mergeLandConfig, type LandConfig } from "./config.js";
import { clearAllShapes } from "./debug-draw.js";
import {
  bindEventsConfig,
  registerLandEvents,
  startHealTicker,
} from "./events.js";
import { pendingBoxes } from "./pending.js";
import { runLeaseScan } from "./lease-scanner.js";
import {
  bindLandConfig,
  handleAuditLog,
  handleById,
  handleByPos,
  handleCreateLease,
  handleExpandLease,
  handleGetPerks,
  handleGuestbookList,
  handleGuestbookSign,
  handleGetPlayerRole,
  handleLeaseStatus,
  handleListByOwner,
  handleListMembers,
  handleRenewLease,
  handleSetPerk,
  handleTeleport,
  handleTerminateLease,
  handleValidateBox,
} from "./services.js";
import { cacheClear, cacheUpsert } from "./cache.js";
import {
  defineLandTables,
  listEffectiveLandsInDimension,
  listPerks,
} from "./store.js";
import { bindLandUiConfig, landUiServices } from "./ui-services.js";
import { openLandUi, registerLandUi, unregisterLandUi } from "./ui.js";

const MODULE_ID = "land";

const unprovide: Array<() => void> = [];
const eventCleanups: Array<() => void> = [];
let landConfig: LandConfig = mergeLandConfig();
let scanRunId: number | undefined;

function getCfg(): LandConfig {
  return landConfig;
}

function requirePlayer(player: Player | undefined): player is Player {
  if (!player) {
    debug.i("Land", "该指令必须由玩家执行");
    return false;
  }
  return true;
}

function registerCommands(): void {
  // 平台 Command 仅匹配首 token；子命令走 SPA（传送/精度起租/状态）
  Command.register(
    "land",
    "land.use",
    (player) => {
      if (!requirePlayer(player)) return;
      // 若已有精度选点缓存，优先完成起租向导；否则打开主控制台
      if (pendingBoxes.has(player.id)) {
        Msg.tips("检测到选点预览，请在控制台「起租向导」确认契约", player);
      }
      void openLandUi(player).catch((error) => {
        debug.w(
          "Land",
          `打开领地 UI 失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    },
    "打开领地租赁控制台",
    MODULE_ID,
  );
}

registerCommands();

ModuleRegistry.register({
  id: MODULE_ID,
  afterWorldLoad: true,
  lifecycle: {
    registerPermissions() {
      Permission.register("land.use", Permission.Any);
      Permission.register("land.gui.use", Permission.Any);
      Permission.register("land.tp", Permission.Any);
      Permission.register("land.admin", Permission.OP);
      Permission.register("land.gui.admin", Permission.OP);
    },
    registerEvents() {
      bindEventsConfig(getCfg);
      registerLandEvents(eventCleanups);
      startHealTicker(eventCleanups);
    },
    async init() {
      bindLandConfig(getCfg);
      bindLandUiConfig(getCfg);

      try {
        const base = await config.get<number>("base_daily_rent");
        const rentPer = await config.get<number>("rent_per_100_blocks");
        const maxLands = await config.get<number>("max_lands_per_player");
        const grace = await config.get<number>("grace_period_days");
        const partial: Partial<LandConfig> = {};
        if (typeof base === "number") partial.base_daily_rent = base;
        if (typeof rentPer === "number") partial.rent_per_100_blocks = rentPer;
        if (typeof maxLands === "number")
          partial.max_lands_per_player = maxLands;
        if (typeof grace === "number") partial.grace_period_days = grace;
        landConfig = mergeLandConfig(partial);
      } catch {
        landConfig = mergeLandConfig();
      }

      await defineLandTables();
      await ensureLandAreaFeatures();

      // 启动时把有效契约重新挂到 area + 内存索引
      cacheClear();
      try {
        for (const dim of [
          "minecraft:overworld",
          "minecraft:nether",
          "minecraft:the_end",
        ]) {
          const lands = await listEffectiveLandsInDimension(dim);
          for (const land of lands) {
            const perks = await listPerks(land.id);
            cacheUpsert(
              land,
              perks.filter((p) => p.enabled).map((p) => p.perk_id),
            );
            await syncLandArea(land);
          }
        }
      } catch (err) {
        debug.w(
          "Land",
          `重挂 area 失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      unprovide.push(
        service.provide("land.byId", (input) => handleById(input)),
      );
      unprovide.push(
        service.provide("land.byPos", (input) => handleByPos(input)),
      );
      unprovide.push(
        service.provide("land.listByOwner", (input) =>
          handleListByOwner(input),
        ),
      );
      unprovide.push(
        service.provide("land.listMembers", (input) =>
          handleListMembers(input),
        ),
      );
      unprovide.push(
        service.provide("land.getPlayerRole", (input) =>
          handleGetPlayerRole(input),
        ),
      );
      unprovide.push(
        service.provide("land.validateBox", (input) =>
          handleValidateBox(input),
        ),
      );
      unprovide.push(
        service.provide("land.createLease", (input) =>
          handleCreateLease(input),
        ),
      );
      unprovide.push(
        service.provide("land.renewLease", (input) => handleRenewLease(input)),
      );
      unprovide.push(
        service.provide("land.expandLease", (input) =>
          handleExpandLease(input),
        ),
      );
      unprovide.push(
        service.provide("land.terminateLease", (input) =>
          handleTerminateLease(input),
        ),
      );
      unprovide.push(
        service.provide("land.teleport", (input) => handleTeleport(input)),
      );
      unprovide.push(
        service.provide("land.leaseStatus", (input) =>
          handleLeaseStatus(input),
        ),
      );
      unprovide.push(
        service.provide("land.getPerks", (input) => handleGetPerks(input)),
      );
      unprovide.push(
        service.provide("land.setPerk", (input) => handleSetPerk(input)),
      );
      unprovide.push(
        service.provide("land.guestbook.list", (input) =>
          handleGuestbookList(input),
        ),
      );
      unprovide.push(
        service.provide("land.guestbook.sign", (input) =>
          handleGuestbookSign(input),
        ),
      );
      unprovide.push(
        service.provide("land.auditLog", (input) => handleAuditLog(input)),
      );
      for (const [name, handler] of Object.entries(landUiServices)) {
        unprovide.push(service.provide(name, handler));
      }

      await registerLandUi();

      // 每小时扫描欠租状态机（72000 ticks ≈ 1h）
      scanRunId = system.runInterval(() => {
        void runLeaseScan(getCfg()).then((r) => {
          if (r.dormant || r.terminated) {
            debug.i(
              "Land",
              `scan dormant=${r.dormant} terminated=${r.terminated}`,
            );
          }
        });
      }, 72_000);

      debug.i("Land", `init ok grace=${landConfig.grace_period_days}d`);
    },
    cleanup() {
      void unregisterLandUi().catch(() => undefined);
      for (const off of unprovide.splice(0, unprovide.length)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      for (const c of eventCleanups.splice(0, eventCleanups.length)) c();
      if (scanRunId !== undefined) {
        try {
          system.clearRun(scanRunId);
        } catch {
          /* ignore */
        }
        scanRunId = undefined;
      }
      clearAllShapes();
      cacheClear();
      debug.i("Land", "cleanup");
    },
  },
});
