/**
 * land 配置类型与默认值。
 */

export interface LandConfig {
  base_daily_rent: number;
  rent_per_100_blocks: number;
  max_lands_per_player: number;
  land_count_multiplier: number[];
  long_term_discounts: Record<string, number>;
  grace_period_days: number;
  default_claim_mode: "vertical" | "box";
  totem: {
    item_type: string;
    item_name: string;
    initial_radius: number;
    max_level: number;
    level_radius: number[];
  };
  mineral_rates: Record<string, number>;
  plaza: {
    name: string;
    welcome: string;
    dimension: string;
    range: number[];
  };
  default_permissions: Record<string, boolean>;
}

export const DEFAULT_LAND_CONFIG: LandConfig = {
  base_daily_rent: 10,
  rent_per_100_blocks: 2,
  max_lands_per_player: 5,
  land_count_multiplier: [1.0, 1.5, 2.0, 3.0, 3.0],
  long_term_discounts: {
    "30": 0.9,
    "90": 0.8,
  },
  grace_period_days: 7,
  default_claim_mode: "vertical",
  totem: {
    item_type: "minecraft:respawn_anchor",
    item_name: "§e§l守护基石 §7[放置即起租]",
    initial_radius: 16,
    max_level: 5,
    level_radius: [16, 24, 32, 48, 64],
  },
  mineral_rates: {
    "minecraft:coal": 0.5,
    "minecraft:iron_ingot": 2,
    "minecraft:gold_ingot": 5,
    "minecraft:emerald": 20,
    "minecraft:diamond": 30,
  },
  plaza: {
    name: "自由广场",
    welcome: "欢迎来到公共安全广场",
    dimension: "minecraft:overworld",
    range: [0, 64, 0, 100, 128, 100],
  },
  default_permissions: {
    allow_place: true,
    allow_destroy: true,
    attack_entity: true,
    open_container: true,
    use_door: true,
    use_button: true,
    use_redstone: true,
    interact_entity: true,
    pickup_item: true,
  },
};

/** 浅合并配置（缺省字段回落默认）。 */
export function mergeLandConfig(partial?: Partial<LandConfig> | null): LandConfig {
  if (!partial) return { ...DEFAULT_LAND_CONFIG, totem: { ...DEFAULT_LAND_CONFIG.totem }, mineral_rates: { ...DEFAULT_LAND_CONFIG.mineral_rates }, plaza: { ...DEFAULT_LAND_CONFIG.plaza }, default_permissions: { ...DEFAULT_LAND_CONFIG.default_permissions }, long_term_discounts: { ...DEFAULT_LAND_CONFIG.long_term_discounts }, land_count_multiplier: [...DEFAULT_LAND_CONFIG.land_count_multiplier] };
  return {
    ...DEFAULT_LAND_CONFIG,
    ...partial,
    totem: { ...DEFAULT_LAND_CONFIG.totem, ...(partial.totem ?? {}) },
    mineral_rates: { ...DEFAULT_LAND_CONFIG.mineral_rates, ...(partial.mineral_rates ?? {}) },
    plaza: { ...DEFAULT_LAND_CONFIG.plaza, ...(partial.plaza ?? {}) },
    default_permissions: {
      ...DEFAULT_LAND_CONFIG.default_permissions,
      ...(partial.default_permissions ?? {}),
    },
    long_term_discounts: {
      ...DEFAULT_LAND_CONFIG.long_term_discounts,
      ...(partial.long_term_discounts ?? {}),
    },
    land_count_multiplier:
      partial.land_count_multiplier ?? [...DEFAULT_LAND_CONFIG.land_count_multiplier],
  };
}
