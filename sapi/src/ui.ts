/** 领地声明式页面的注册与打开入口。 */

import type { Player } from "@minecraft/server";
import { service } from "@sfmc-bds/sdk/sapi/service";
import featureUi from "./ui/feature.ui.json" with { type: "json" };
import detailUi from "./ui/screens/detail.ui.json" with { type: "json" };
import homeUi from "./ui/screens/home.ui.json" with { type: "json" };
import leaseUi from "./ui/screens/lease.ui.json" with { type: "json" };
import listUi from "./ui/screens/list.ui.json" with { type: "json" };
import perksUi from "./ui/screens/perks.ui.json" with { type: "json" };
import teleportUi from "./ui/screens/teleport.ui.json" with { type: "json" };

const MODULE_ID = "land";

export async function registerLandUi(): Promise<void> {
  const result = await service.call<{ ok?: boolean; error?: string }>(
    "gui.registerFeature",
    {
      feature: featureUi,
      screens: {
        "screens/home.ui.json": homeUi,
        "screens/list.ui.json": listUi,
        "screens/detail.ui.json": detailUi,
        "screens/perks.ui.json": perksUi,
        "screens/lease.ui.json": leaseUi,
        "screens/teleport.ui.json": teleportUi,
      },
    },
  );
  if (!result?.ok) throw new Error(result?.error || "领地 UI 注册失败");
}

export function unregisterLandUi(): Promise<unknown> {
  return service.call("gui.unregisterFeature", { moduleId: MODULE_ID });
}

export function openLandUi(
  player: Player,
  screenId = "land.home",
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return service.call("gui.openScreen", {
    playerId: player.id,
    moduleId: MODULE_ID,
    screenId,
    params,
  });
}
