/**
 * IntruderDetector - Watches for non-whitelisted players entering render distance.
 *
 * Events:
 *   'intruder' (playerName: string)
 *       - Emitted once per player per session when they enter render distance.
 *         Cleared when they leave, so re-entry triggers a fresh alert.
 */

const EventEmitter = require('events');

class IntruderDetector extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('./whitelist')} whitelist
   * @param {object} logger
   */
  constructor(bot, whitelist, logger) {
    super();
    this.bot = bot;
    this.whitelist = whitelist;
    this.logger = logger;
    this._active = false;
    this._spawnHandler = null;
    this._goneHandler = null;
    /** @type {Set<string>} usernames already alerted this session */
    this._alerted = new Set();
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._spawnHandler = (entity) => this._onEntitySpawn(entity);
    this._goneHandler = (entity) => this._onEntityGone(entity);
    this.bot.on('entitySpawn', this._spawnHandler);
    this.bot.on('entityGone', this._goneHandler);
    this.logger.info('IntruderDetector started');
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    if (this._spawnHandler) {
      this.bot.removeListener('entitySpawn', this._spawnHandler);
      this._spawnHandler = null;
    }
    if (this._goneHandler) {
      this.bot.removeListener('entityGone', this._goneHandler);
      this._goneHandler = null;
    }
    this._alerted.clear();
  }

  _onEntitySpawn(entity) {
    if (entity.type !== 'player') return;
    const name = entity.username;
    if (!name || name === this.bot.username) return;
    if (this.whitelist.isAuthorized(name)) return;
    if (this._alerted.has(name)) return;

    this._alerted.add(name);
    this.logger.warn(`Intruder detected: ${name} entered render distance`);
    this.emit('intruder', name);
  }

  _onEntityGone(entity) {
    if (entity.type !== 'player') return;
    const name = entity.username;
    if (!name) return;
    if (this._alerted.has(name)) {
      this._alerted.delete(name);
      this.logger.info(`Intruder ${name} left render distance`);
    }
  }
}

module.exports = IntruderDetector;
