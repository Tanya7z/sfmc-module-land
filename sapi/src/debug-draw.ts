/**
 * DebugBox / DebugText 渲染门面：无 debug-utilities 时降级为粒子边界提示。
 */

import { Player, system, world, type Vector3 } from "@minecraft/server";
import { debug } from "@sfmc-bds/sdk/sapi/runtime";
import type { Aabb } from "./types.js";
import { LAND_COLORS } from "./types.js";

type Rgba = { red: number; green: number; blue: number; alpha: number };

interface ShapeHandle {
  remove(): void;
}

interface DebugApi {
  addBox(box: Aabb, color: Rgba): ShapeHandle | null;
  addText(location: Vector3, text: string): ShapeHandle | null;
  available: boolean;
}

const shapeByKey = new Map<string, ShapeHandle[]>();

let cachedApi: DebugApi | null = null;
let resolved = false;

function particleFallback(box: Aabb, color: Rgba): ShapeHandle {
  let alive = true;
  const runId = system.runInterval(() => {
    if (!alive) return;
    try {
      const dim = world.getDimension("overworld");
      // 仅在四角轻量粒子，避免卡顿
      const corners: Vector3[] = [
        { x: box.min.x, y: box.min.y + 1, z: box.min.z },
        { x: box.max.x, y: box.min.y + 1, z: box.min.z },
        { x: box.min.x, y: box.min.y + 1, z: box.max.z },
        { x: box.max.x, y: box.min.y + 1, z: box.max.z },
      ];
      const molang = color.green > 0.8 ? "minecraft:crop_growth_emitter" : "minecraft:basic_flame_particle";
      for (const c of corners) {
        try {
          dim.spawnParticle(molang, c);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }, 40);
  return {
    remove() {
      alive = false;
      try {
        system.clearRun(runId);
      } catch {
        /* ignore */
      }
    },
  };
}

async function resolveApi(): Promise<DebugApi> {
  if (resolved && cachedApi) return cachedApi;
  resolved = true;
  try {
    // 动态加载：未开启实验/未打包时优雅降级
    const mod = (await import(
      /* webpackIgnore: true */ "@minecraft/debug-utilities" as string
    )) as {
      debugDrawer?: { addShape: (s: unknown) => void };
      DebugBox?: new (loc: Vector3) => {
        color: Rgba;
        bound?: Vector3;
        scale?: Vector3;
        remove?: () => void;
      };
      DebugText?: new (loc: Vector3, text: string) => {
        color?: Rgba;
        remove?: () => void;
      };
    };
    const drawer = mod.debugDrawer;
    const DebugBox = mod.DebugBox;
    const DebugText = mod.DebugText;
    if (!drawer || !DebugBox) {
      throw new Error("debug-utilities incomplete");
    }
    cachedApi = {
      available: true,
      addBox(box, color) {
        try {
          const loc: Vector3 = { x: box.min.x, y: box.min.y, z: box.min.z };
          const shape = new DebugBox(loc);
          shape.color = color;
          // 部分版本用 bound/scale 描述对角；尽力适配
          const sx = box.max.x - box.min.x + 1;
          const sy = box.max.y - box.min.y + 1;
          const sz = box.max.z - box.min.z + 1;
          if ("scale" in shape) {
            (shape as { scale: Vector3 }).scale = { x: sx, y: sy, z: sz };
          } else if ("bound" in shape) {
            (shape as { bound: Vector3 }).bound = {
              x: box.max.x + 1,
              y: box.max.y + 1,
              z: box.max.z + 1,
            };
          }
          drawer.addShape(shape);
          return {
            remove() {
              try {
                shape.remove?.();
              } catch {
                /* ignore */
              }
            },
          };
        } catch (err) {
          debug.w(
            "LandDebug",
            `DebugBox 失败，降级粒子: ${err instanceof Error ? err.message : String(err)}`,
          );
          return particleFallback(box, color);
        }
      },
      addText(location, text) {
        if (!DebugText) return null;
        try {
          const shape = new DebugText(location, text);
          drawer.addShape(shape);
          return {
            remove() {
              try {
                shape.remove?.();
              } catch {
                /* ignore */
              }
            },
          };
        } catch {
          return null;
        }
      },
    };
  } catch {
    debug.w("LandDebug", "@minecraft/debug-utilities 不可用，使用粒子边界降级");
    cachedApi = {
      available: false,
      addBox(box, color) {
        return particleFallback(box, color);
      },
      addText() {
        return null;
      },
    };
  }
  return cachedApi;
}

export function clearShapes(key: string): void {
  const list = shapeByKey.get(key);
  if (!list) return;
  for (const s of list) {
    try {
      s.remove();
    } catch {
      /* ignore */
    }
  }
  shapeByKey.delete(key);
}

export function clearAllShapes(): void {
  for (const key of [...shapeByKey.keys()]) clearShapes(key);
}

/** 挂载领地线框与名牌；key 通常为 landId 或 preview:<playerId>。 */
export async function showLandHighlight(opts: {
  key: string;
  box: Aabb;
  color: Rgba;
  label?: string;
  labelAt?: Vector3;
}): Promise<void> {
  clearShapes(opts.key);
  const api = await resolveApi();
  const handles: ShapeHandle[] = [];
  const boxHandle = api.addBox(opts.box, opts.color);
  if (boxHandle) handles.push(boxHandle);
  if (opts.label && opts.labelAt) {
    const t = api.addText(opts.labelAt, opts.label);
    if (t) handles.push(t);
  }
  if (handles.length) shapeByKey.set(opts.key, handles);
}

export function colorForViewer(viewerId: string, ownerId: string, isPlaza = false): Rgba {
  if (isPlaza) return { ...LAND_COLORS.plaza };
  if (viewerId === ownerId) return { ...LAND_COLORS.own };
  return { ...LAND_COLORS.other };
}

export function previewColor(): Rgba {
  return { ...LAND_COLORS.preview };
}

/** 视距生命周期：玩家靠近时挂载，离开后释放（由外部周期调用）。 */
export function shouldRenderForPlayer(
  player: Player,
  core: Vector3,
  radius = 16,
): boolean {
  try {
    if (player.dimension.id !== "minecraft:overworld" && player.dimension.id !== core.x.toString()) {
      /* dimension 由调用方另行校验 */
    }
    const loc = player.location;
    const dx = loc.x - core.x;
    const dz = loc.z - core.z;
    return dx * dx + dz * dz <= radius * radius;
  } catch {
    return false;
  }
}
