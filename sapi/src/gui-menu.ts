/**
 * 领地 SPA 控制台（MenuNavigator）与 gui 菜单挂载。
 */

import type { Player } from "@minecraft/server";
import {
  FormStatus,
  ListFormInfo,
  MenuNavigator,
  Msg,
  debug,
  obsBool,
  obsNum,
  obsStr,
  type Page,
} from "@sfmc-bds/sdk/sapi/runtime";
import { service } from "@sfmc-bds/sdk/sapi/service";
import { totemBoxFromCore } from "./aabb.js";
import type { LandConfig } from "./config.js";
import { previewColor, showLandHighlight } from "./debug-draw.js";
import { pendingBoxes } from "./pending.js";
import { calcPeriodRent } from "./rent.js";
import {
  findPublicLandByName,
  handleCreateLease,
  handleExpandLease,
  handleGetPerks,
  handleListByOwner,
  handleRenewLease,
  handleSetPerk,
  handleTeleport,
  handleTerminateLease,
} from "./services.js";
import { getLandById } from "./store.js";
import { ALL_PERKS, type PerkId } from "./types.js";

let cfgGetter: () => LandConfig = () => {
  throw new Error("config missing");
};

/** 当前详情页绑定的 landId（跨 section 共享）。 */
const selectedLand = new Map<string, string>();

export function bindGuiConfig(getter: () => LandConfig): void {
  cfgGetter = getter;
}

export async function openMainMenu(player: Player): Promise<{ ok: boolean }> {
  const nav = new MenuNavigator(player);
  const renewDays = obsNum(7);
  const expandLevel = obsNum(1);
  const leaseDays = obsNum(7);
  const leaseName = obsStr(`${player.name}的庄园`);
  const tpName = obsStr("");

  nav.section("root", "领地控制台", async (page) => {
    new FormStatus(page);
    page.header("领地租赁控制台");
    page.label(ListFormInfo(["只租不卖 · 契约庄园"]));
    page.spacer();
    page.button("我的庄园", () => {
      nav.go("my_lands");
      void nav.rebuild();
    });
    page.button("起租向导", () => {
      nav.go("lease_wizard");
      void nav.rebuild();
    });
    page.button("传送公开地标", () => {
      nav.go("teleport");
      void nav.rebuild();
    });
  });

  nav.section("teleport", "公开地标", async (page) => {
    const status = new FormStatus(page);
    page.header("传送公开地标");
    page.label(ListFormInfo(["输入公开庄园名称（需 land.tp 权限）"]));
    page.textField("庄园名称", tpName);
    page.button("支付门票并传送", () => {
      void nav.runTask(status, async () => {
        const name = tpName.getData().trim();
        if (!name) throw new Error("请输入庄园名");
        const land = await findPublicLandByName(name);
        if (!land) throw new Error("未找到公开地标");
        const res = await handleTeleport({ playerId: player.id, landId: land.id });
        if (!res.ok) throw new Error(res.error ?? "传送失败");
        status.ok(`已传送，门票 ${res.feePaid ?? 0}`);
        nav.leave(() => undefined);
      });
    });
  });

  nav.section("my_lands", "我的庄园", async (page) => {
    const { lands } = await handleListByOwner({ ownerId: player.id, limit: 20 });
    page.header("我的庄园");
    page.label(ListFormInfo([`名下契约：${lands.length} 块`]));
    if (lands.length === 0) {
      page.label("暂无有效契约，请放置守护基石或使用起租向导。");
    }
    for (const land of lands) {
      const id = String(land.id);
      const title = `${String(land.name)} [${String(land.status)}]`;
      page.button(title, () => {
        selectedLand.set(player.id, id);
        expandLevel.setData(Number(land.level) || 1);
        nav.go("land_detail");
        void nav.rebuild();
      });
    }
  });

  nav.section("land_detail", "庄园详情", async (page) => {
    const status = new FormStatus(page);
    const landId = selectedLand.get(player.id) ?? "";
    const land = landId ? await getLandById(landId) : null;
    if (!land) {
      page.label("领地不存在");
      return;
    }
    page.header(land.name);
    page.label(
      ListFormInfo([
        `状态 ${land.status} · 日租 ${land.daily_rent}`,
        `到期 ${new Date(land.lease_until).toLocaleString()} · Lv.${land.level}`,
        `门票 ${land.ticket_price} · 公开 ${land.is_public ? "是" : "否"}`,
      ]),
    );
    page.slider("续租天数", renewDays, 1, 90);
    page.button("确认续租（节操币）", () => {
      void nav.runTask(status, async () => {
        const days = Math.max(1, Math.floor(renewDays.getData()));
        const res = await handleRenewLease({ landId, days, actorId: player.id });
        if (!res.ok) throw new Error(res.error ?? "续租失败");
        status.ok(`续租成功`);
        await nav.rebuild();
      });
    });
    page.divider();
    page.slider("扩建等级", expandLevel, land.level, cfgGetter().totem.max_level);
    page.button("预览扩建线框", () => {
      void (async () => {
        const cfg = cfgGetter();
        const lv = Math.max(land.level, Math.floor(expandLevel.getData()));
        const radius = cfg.totem.level_radius[lv - 1] ?? cfg.totem.initial_radius;
        const box = totemBoxFromCore(
          { x: land.core_x, y: land.core_y, z: land.core_z },
          radius,
        );
        await showLandHighlight({
          key: `preview:${player.id}`,
          box,
          color: previewColor(),
          label: `§e扩建预览 Lv.${lv}`,
          labelAt: { x: land.core_x, y: land.core_y + 3, z: land.core_z },
        });
        Msg.tips("已挂载金黄预览线框", player);
      })();
    });
    page.button("确认扩建", () => {
      void nav.runTask(status, async () => {
        const cfg = cfgGetter();
        const lv = Math.max(land.level, Math.floor(expandLevel.getData()));
        const radius = cfg.totem.level_radius[lv - 1] ?? cfg.totem.initial_radius;
        const box = totemBoxFromCore(
          { x: land.core_x, y: land.core_y, z: land.core_z },
          radius,
        );
        const res = await handleExpandLease({
          landId,
          newMin: box.min,
          newMax: box.max,
        });
        if (!res.ok) throw new Error(res.error ?? "扩建失败");
        status.ok(`扩建成功，补差 ${res.feeDiff ?? 0}`);
        await nav.rebuild();
      });
    });
    page.divider();
    page.button("增益插槽", () => {
      nav.go("perks");
      void nav.rebuild();
    });
    page.button("解除契约", () => {
      void nav.runTask(status, async () => {
        const ok = await nav.confirmMessage("解除契约", "确认解除？建筑保护将立即失效。");
        if (!ok) return;
        const res = await handleTerminateLease({ landId, playerId: player.id });
        if (!res.ok) throw new Error(res.error ?? "解除失败");
        status.ok("契约已解除");
        nav.back();
        await nav.rebuild();
      });
    });
  });

  nav.section("perks", "增益插槽", async (page) => {
    const status = new FormStatus(page);
    const landId = selectedLand.get(player.id) ?? "";
    const { perks } = await handleGetPerks({ landId });
    page.header("庄园增益");
    page.label(ListFormInfo(["休眠期增益自动暂停"]));
    const enabled = new Map(
      (perks as Array<{ perkId: string; enabled: boolean }>).map((p) => [p.perkId, p.enabled]),
    );
    for (const perk of ALL_PERKS) {
      const t = obsBool(!!enabled.get(perk));
      page.toggle(`启用 ${perk}`, t);
      page.button(`保存 ${perk}`, () => {
        void nav.runTask(status, async () => {
          await handleSetPerk({
            landId,
            perkId: perk as PerkId,
            enabled: t.getData(),
          });
          status.ok(`已更新 ${perk}`);
        });
      });
    }
  });

  nav.section("lease_wizard", "起租向导", async (page) => {
    const status = new FormStatus(page);
    const cfg = cfgGetter();
    const pending = pendingBoxes.get(player.id);
    page.header(pending ? "精度选点起租" : "基石半径起租");
    page.label(
      ListFormInfo(
        pending
          ? ["使用已缓存的金镐选点盒", "确认后扣除首期租金"]
          : ["以当前位置为中心", "垂直通天初始半径"],
      ),
    );
    page.textField("庄园名称", leaseName);
    page.slider("租期天数", leaseDays, 1, 90);
    page.button("预览并估价", () => {
      void (async () => {
        const days = Math.max(1, Math.floor(leaseDays.getData()));
        if (pending) {
          await showLandHighlight({
            key: `preview:${player.id}`,
            box: pending.box,
            color: previewColor(),
            label: "§e选点预览",
            labelAt: {
              x: (pending.box.min.x + pending.box.max.x) / 2,
              y: pending.box.max.y + 1,
              z: (pending.box.min.z + pending.box.max.z) / 2,
            },
          });
          const estimate = calcPeriodRent(cfg.base_daily_rent, days, cfg);
          Msg.info(`预览已挂载；参考价约 ${estimate}`, player);
          return;
        }
        const loc = player.location;
        const box = totemBoxFromCore(
          { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) },
          cfg.totem.initial_radius,
        );
        await showLandHighlight({
          key: `preview:${player.id}`,
          box,
          color: previewColor(),
          label: "§e起租预览",
          labelAt: { x: loc.x, y: loc.y + 2, z: loc.z },
        });
        const estimate = calcPeriodRent(cfg.base_daily_rent, days, cfg);
        Msg.info(`预览已挂载；参考价约 ${estimate}`, player);
      })();
    });
    page.button("确认起租", () => {
      void nav.runTask(status, async () => {
        const days = Math.max(1, Math.floor(leaseDays.getData()));
        const name = leaseName.getData() || `${player.name}的庄园`;
        let res;
        if (pending) {
          res = await handleCreateLease({
            playerId: player.id,
            dimension: pending.dimension,
            days,
            name,
            min: pending.box.min,
            max: pending.box.max,
          });
          pendingBoxes.delete(player.id);
        } else {
          const loc = player.location;
          res = await handleCreateLease({
            playerId: player.id,
            dimension: player.dimension.id,
            days,
            name,
            isTotem: true,
            core: {
              x: Math.floor(loc.x),
              y: Math.floor(loc.y),
              z: Math.floor(loc.z),
            },
          });
        }
        if (!res.ok) throw new Error(res.error ?? "起租失败");
        status.ok(`起租成功：${res.landId}`);
        nav.leave(() => {
          Msg.success(`领地已创建：${res.landId}`, player);
        });
      });
    });
  });

  await nav.start("root");
  return { ok: true };
}

export async function tryRegisterGuiMenu(): Promise<void> {
  try {
    await service.call("gui.registerMenuItem", {
      id: "land.main",
      title: "领地庄园",
      order: 30,
      category: "general",
      permission: "land.gui.use",
      build: async (_page: Page, _nav: MenuNavigator) => {
        /* 实际由 handler 打开独立 SPA，避免嵌套过深 */
      },
      handler: (player: Player) => {
        void openMainMenu(player);
      },
    } as unknown as Record<string, unknown>);
    debug.i("LandGui", "gui.registerMenuItem ok");
  } catch (err) {
    debug.w(
      "LandGui",
      `gui.registerMenuItem 不可用: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
