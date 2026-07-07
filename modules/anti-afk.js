/**
 * AntiAFK - Keeps the bot from being kicked for idling on 2b2t.
 *
 * IMPORTANT (2b2t mechanics): rotating the head or jumping in place does NOT
 * reset 2b2t's AFK timer — with no real activity you're kicked within ~5
 * minutes, and even continuous walking is kicked at ~30 minutes. The reliable
 * anti-AFK methods are BLOCK INTERACTIONS: breaking/placing, or toggling a
 * door/lever/trapdoor. So each interval this module:
 *
 *   1. Toggles a dedicated lever/door/trapdoor (config: stasis.afk_toggle) —
 *      the reliable anti-kick. Place it next to the bot; it must NOT be a
 *      trapdoor sitting above a stored pearl.
 *   2. Optionally paces one sneaked step back-and-forth so the bot visibly
 *      moves without walking off a ledge (config: anti_afk.patrol, default on).
 *   3. Swings its arm — a cheap extra activity ping.
 *
 * Config:
 *   anti_afk.enabled      boolean  (default true)
 *   anti_afk.interval_ms  number   (default 120000; keep it under ~4 min)
 *   anti_afk.patrol       boolean  (default true) — step back-and-forth
 *   stasis.afk_toggle     {x,y,z}  — block to flip each cycle (recommended)
 */

const Vec3 = require('vec3');

class AntiAFK {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} config - the full per-bot config (reads config.anti_afk and config.stasis)
   * @param {import('./logger.js')} logger
   */
  constructor(bot, config, logger) {
    this.bot = bot;
    this.logger = logger;

    const full = config || {};
    const afk = full.anti_afk || {};
    const stasis = full.stasis || {};

    this.enabled = afk.enabled !== false;
    this.intervalMs = afk.interval_ms || 120000;
    this.doPatrol = afk.patrol !== false;

    // Accept the toggle-block position from stasis.afk_toggle (preferred, since
    // stasis is always per-bot) or anti_afk.toggle_block (fallback).
    const t = stasis.afk_toggle || afk.toggle_block || null;
    this.togglePos =
      t && typeof t.x === 'number' && typeof t.y === 'number' && typeof t.z === 'number'
        ? new Vec3(t.x, t.y, t.z)
        : null;

    this._timer = null;
    this._busy = false;
  }

  /**
   * Start the anti-AFK loop.
   * @returns {boolean} true if started, false if disabled or already running
   */
  start() {
    if (this._timer !== null) {
      this.logger.warn('AntiAFK already started');
      return false;
    }
    if (!this.enabled) {
      this.logger.info('AntiAFK disabled by config');
      return false;
    }

    if (!this.togglePos) {
      this.logger.warn(
        'AntiAFK: no stasis.afk_toggle configured — on 2b2t the bot will still ' +
        'get AFK-kicked without a block to interact with. Place a lever next to ' +
        'the bot and set its coords in stasis.afk_toggle.'
      );
    }

    this.logger.info(
      `AntiAFK started — every ${Math.round(this.intervalMs / 1000)}s` +
      `${this.togglePos ? `, toggling block at ${this.togglePos}` : ''}` +
      `${this.doPatrol ? ', with patrol' : ''}`
    );

    this._timer = setInterval(() => {
      this._tick().catch((err) => this.logger.error(`AntiAFK action failed: ${err.message}`));
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();

    return true;
  }

  /** Stop the anti-AFK loop. Safe to call multiple times. */
  stop() {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
    this.logger.debug('AntiAFK stopped');
  }

  async _tick() {
    if (this._busy) return; // a slow previous cycle is still running
    this._busy = true;
    try {
      // 1. Arm swing — cheap activity ping.
      try { this.bot.swingArm('right'); } catch { /* noop */ }

      // 2. Toggle the dedicated block — the reliable 2b2t anti-kick.
      if (this.togglePos) await this._toggleBlock();

      // 3. Patrol — visibly move without leaving the platform.
      if (this.doPatrol) await this._patrol();
    } finally {
      this._busy = false;
    }
  }

  async _toggleBlock() {
    const block = this.bot.blockAt(this.togglePos);
    if (!block || block.name === 'air') {
      this.logger.warn(`AntiAFK: no block at ${this.togglePos} (out of render range, or wrong coords)`);
      return;
    }
    try {
      await this.bot.lookAt(this.togglePos.offset(0.5, 0.5, 0.5), true);
      await this.bot.activateBlock(block);
      this.logger.debug(`AntiAFK: toggled ${block.name} at ${this.togglePos}`);
    } catch (err) {
      this.logger.warn(`AntiAFK: failed to toggle block at ${this.togglePos}: ${err.message}`);
    }
  }

  /**
   * Step forward then back, sneaking the whole time so the bot can't walk off a
   * ledge. Symmetric timing keeps it roughly on its original spot.
   */
  async _patrol() {
    const hold = (control, ms) => new Promise((resolve) => {
      try { this.bot.setControlState(control, true); } catch { /* noop */ }
      setTimeout(() => {
        try { this.bot.setControlState(control, false); } catch { /* noop */ }
        resolve();
      }, ms);
    });

    try { this.bot.setControlState('sneak', true); } catch { /* noop */ }
    try {
      await hold('forward', 500);
      await hold('back', 500);
    } catch (err) {
      this.logger.debug(`AntiAFK patrol failed: ${err.message}`);
    } finally {
      try { this.bot.setControlState('sneak', false); } catch { /* noop */ }
    }
  }
}

module.exports = AntiAFK;
