const EventEmitter = require('events');

// Hostile mob types to target — covers all standard overworld/nether threats
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

class Aura extends EventEmitter {
  constructor(bot, config, logger) {
    super();
    this.bot = bot;
    this.logger = logger;

    const cfg = config.aura || {};
    this.enabled = cfg.enabled !== false;
    this.range = cfg.range ?? 5;
    this.intervalMs = cfg.interval_ms ?? 500;

    this._timer = null;
    this._bound_onEntityHurt = this._onEntityHurt.bind(this);
  }

  start() {
    if (!this.enabled) return;
    this._timer = setInterval(() => this._tick(), this.intervalMs);
    this.logger.info(`Aura started — range: ${this.range}m, interval: ${this.intervalMs}ms`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _tick() {
    const bot = this.bot;
    if (!bot.entity || !bot.physicsEnabled) return;

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
      // Face the entity before attacking so the server accepts the hit
      bot.lookAt(nearest.position.offset(0, nearest.height / 2, 0), true);
      bot.attack(nearest);
      this.logger.debug(`Aura: attacked ${nearest.name} at distance ${nearestDist.toFixed(1)}m`);
      this.emit('attack', nearest);
    } catch (err) {
      this.logger.debug(`Aura: attack error — ${err.message}`);
    }
  }
}

module.exports = Aura;
