/**
 * Navigator - walks the bot to the stasis chamber using mineflayer-pathfinder.
 *
 * Loads the pathfinder plugin once on construction, then exposes
 * goToChamber() which resolves when the bot arrives or is already close enough.
 *
 * Limitations:
 *   - Works well for moderate distances (hundreds of blocks). For chambers
 *     thousands of blocks from spawn the bot would need to already be nearby
 *     before pathfinding takes over.
 *   - Does not handle elytra, boats, or horses — walking only.
 */

const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');

class Navigator {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} config
   * @param {import('./logger')} logger
   * @param {object} [_deps] - Injectable deps for testing (Movements, GoalNear)
   */
  constructor(bot, config, logger, _deps = {}) {
    this.bot = bot;
    this.config = config;
    this.logger = logger;
    this._Movements = _deps.Movements || Movements;
    this._GoalNear = _deps.GoalNear || GoalNear;

    bot.loadPlugin(pathfinder);
  }

  /**
   * Walk to the stasis chamber center configured in config.stasis.chamber_center.
   * Returns immediately if already within arrivalRadius blocks.
   *
   * @param {number} [arrivalRadius=3] - Blocks from center that counts as arrived
   * @returns {Promise<void>} Resolves on arrival; rejects if pathfinding fails
   */
  async goToChamber(arrivalRadius = 3) {
    const { x, y, z } = this.config.stasis.chamber_center;
    const pos = this.bot.entity.position;
    const dx = pos.x - x;
    const dy = pos.y - y;
    const dz = pos.z - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (dist <= arrivalRadius) {
      this.logger.info(`Already at chamber (${dist.toFixed(1)} blocks away)`);
      return;
    }

    this.logger.info(
      `Navigating to chamber at ${x}, ${y}, ${z} — ${dist.toFixed(0)} blocks away`
    );

    const movements = new this._Movements(this.bot);
    movements.allowParkour = false;
    movements.allowSprinting = true;
    this.bot.pathfinder.setMovements(movements);

    await this.bot.pathfinder.goto(new this._GoalNear(x, y, z, arrivalRadius));

    this.logger.info('Arrived at stasis chamber');
  }

  /**
   * Stop any active pathfinding immediately.
   */
  stop() {
    try {
      this.bot.pathfinder.stop();
    } catch {
      // pathfinder may not be active
    }
  }
}

module.exports = Navigator;
