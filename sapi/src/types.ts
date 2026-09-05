/**
 * land 类型、色彩与增益常量。
 */

export type LandStatus = "active" | "dormant" | "terminated";

export type MemberRole = "owner" | "admin" | "member" | "guest";

export type PerkId = "noboom" | "peace" | "fireproof" | "heal" | "nofall";

export type OperationType = "lease" | "renew" | "expand" | "ticket" | "disband";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export interface LandRow {
  id: string;
  owner_id: string;
  name: string;
  dimension: string;
  min_x: number;
  min_y: number;
  min_z: number;
  max_x: number;
  max_y: number;
  max_z: number;
  core_x: number;
  core_y: number;
  core_z: number;
  level: number;
  status: LandStatus;
  daily_rent: number;
  lease_until: number;
  grace_until: number;
  ticket_price: number;
  is_public: number;
  likes_count: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface MemberRow {
  land_id: string;
  player_id: string;
  role: MemberRole;
  permissions_json: string;
  updated_at: number;
}

export interface PerkRow {
  land_id: string;
  perk_id: PerkId;
  enabled: number;
  settings_json: string;
}

/** DebugDrawer 所有权色彩（RGBA 0~1）。 */
export const LAND_COLORS = {
  own: { red: 0.2, green: 1.0, blue: 0.4, alpha: 0.6 },
  other: { red: 1.0, green: 0.2, blue: 0.2, alpha: 0.5 },
  plaza: { red: 0.2, green: 0.7, blue: 1.0, alpha: 0.5 },
  preview: { red: 1.0, green: 0.8, blue: 0.2, alpha: 0.8 },
} as const;

export const ALL_PERKS: readonly PerkId[] = [
  "noboom",
  "peace",
  "fireproof",
  "heal",
  "nofall",
];

/** area.features 键：避免与独立 peace-area 等模块撞名。 */
export function perkFeatureKey(perkId: PerkId): string {
  return `land_${perkId}`;
}

export function areaNameForLand(landId: string): string {
  return `land:${landId}`;
}

export const DAY_MS = 86_400_000;
