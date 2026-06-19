const EventEmitter = require('events');

const HOSTILE_TYPES = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned',
  'skeleton', 'stray', 'bogged',
  'creeper', 'spider', 'cave_spider',
  'enderman', 'endermite',
  'witch', 'phantom', 'slime', 'magma_cube',
  'blaze', 'ghast', 'wither_skeleton', 'piglin_brute',
  'hoglin', 'zoglin', 'ravager', 'vex',
  'pillager', 'vindicator', 'evoker', 'illusioner',
  'elder_guardian', 'guardian', 'shulker',
  'silverfish', 'warden',
]);

// Fallback attack speed (attacks/sec) by item name, used when the server hasn't
// sent the attribute packet yet. Values match vanilla 1.9+ item data.
const ITEM_ATTACK_SPEED = {
  wooden_sword: 1.6,  stone_sword: 1.6,   iron_sword: 1.6,
  golden_sword: 1.6,  diamond_sword: 1.6, netherite_sword: 1.6,
  wooden_axe: 0.8,    stone_axe: 0.8,     iron_axe: 0.9,
  golden_axe: 1.0,    diamond_axe: 1.0,   netherite_axe: 1.0,
  wooden_pickaxe: 1.2, stone_pickaxe: 1.2, iron_pickaxe: 1.2,
  golden_pickaxe: 1.2, diamond_pickaxe: 1.2, netherite_pickaxe: 1.2,
  wooden_shovel: 1.0,  stone_shovel: 1.0,  iron_shovel: 1.0,
  golden_shovel: 1.0,  diamond_shovel: 1.0, netherite_shovel: 1.0,
  wooden_hoe: 1.0,     stone_hoe: 2.0,     iron_hoe: 3.0,
  golden_hoe: 4.0,     diamond_hoe: 4.0,   netherite_hoe: 4.0,
  trident: 1.1,
};

const BARE_HAND_SPEED = 4.0; // 5 ticks / 250ms cooldown

class Aura extends EventEmitter {
  constructor(bot, config, logger) {
    super();
    this.bot = bot;
    this.logger = logger;

    const cfg = config.aura || {};
    this.enabled = cfg.enabled !== false;
    this.range = cfg.range ?? 5;

    // Start at Infinity so the first attack fires immediately when a mob is near.
    this._ticksSinceAttack = Infinity;
    this._onTick = this._tick.bind(this);
  }

  start() {
    if (!this.enabled) return;
    this.bot.on('physicTick', this._onTick);
    this.logger.info(`Aura started — range: ${this.range}m`);
  }

  stop() {
    this.bot.off('physicTick', this._onTick);
  }

  // Returns attacks/second for the currently held item.
  // Priority: server attribute (most accurate) → item table → bare-hand default.
  _attackSpeed() {
    const attr = this.bot.entity?.attributes?.['minecraft:generic.attack_speed'];
    if (attr?.value != null) return attr.value;

    const item = this.bot.heldItem;
    if (item) {
      const speed = ITEM_ATTACK_SPEED[item.name];
      if (speed != null) return speed;
    }

    return BARE_HAND_SPEED;
  }

  _tick() {
    this._ticksSinceAttack++;

    const bot = this.bot;
    if (!bot.entity || !bot.physicsEnabled) return;

    // 1.9+ cooldown: full charge needs (20 / attackSpeed) ticks.
    // We wait until ticksSinceAttack >= cooldownTicks so we always hit at 100%.
    const cooldownTicks = 20 / this._attackSpeed();
    if (this._ticksSinceAttack < cooldownTicks) return;

    const pos = bot.entity.position;
    let nearest = null;
    let nearestDist = Infinity;

    for (const entity of Object.values(bot.entities)) {
      if (entity === bot.entity) continue;
      if (entity.type !== 'mob') continue;

      const name = entity.name?.toLowerCase();
      if (!name || !HOSTILE_TYPES.has(name)) continue;

      const dist = entity.position.distanceTo(pos);
      if (dist <= this.range && dist < nearestDist) {
        nearest = entity;
        nearestDist = dist;
      }
    }

    if (!nearest) return;

    try {
      bot.lookAt(nearest.position.offset(0, nearest.height / 2, 0), true);
      bot.attack(nearest);
      this._ticksSinceAttack = 0;
      this.logger.debug(
        `Aura: attacked ${nearest.name} at ${nearestDist.toFixed(1)}m` +
        ` (cooldown ${cooldownTicks.toFixed(1)} ticks)`
      );
      this.emit('attack', nearest);
    } catch (err) {
      this.logger.debug(`Aura: attack error — ${err.message}`);
    }
  }
}

module.exports = Aura;
