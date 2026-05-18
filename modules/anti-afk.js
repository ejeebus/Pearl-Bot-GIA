/**
 * AntiAFK - Prevents the bot from being kicked for idling.
 *
 * Performs subtle periodic actions (look around, sneak toggle, small jump,
 * chat ping) to appear active while staying in the stasis chamber position.
 *
 * The bot never moves from its position — no walking, pathfinding, or block
 * interactions. All actions are local movements or network pings.
 *
 * Modes:
 *   look_around   — vary yaw/pitch by ±0.5 radians via bot.look()
 *   sneak_toggle  — quickly sneak then unsneak via setControlState
 *   small_jump    — jump in place via setControlState (200ms duration)
 *   chat_ping     — send a minimal chat message for network activity
 */

class AntiAFK {
  /**
   * @param {import('mineflayer').Bot} bot - Mineflayer bot instance
   * @param {object} config - config.anti_afk settings from main config
   * @param {boolean} [config.enabled] - Whether anti-AFK is enabled
   * @param {number} [config.interval_ms] - Interval between actions (ms)
   * @param {string} [config.mode] - Preferred mode name
   * @param {string[]} [config.modes] - Available mode names
   * @param {import('./logger.js')} logger - Logger instance
   */
  constructor(bot, config, logger) {
    this.bot = bot;
    this.config = config || {};
    this.logger = logger;

    /** @type {object|null} */
    this._timer = null;

    /** @type {number} Index into modes array for round-robin rotation */
    this._modeIndex = 0;

    /** @type {number} Accumulator for look_around to produce smooth variation */
    this._lookTick = 0;

    /** Valid mode names and their handler methods */
    this._MODE_HANDLERS = {
      look_around: '_doLookAround',
      sneak_toggle: '_doSneakToggle',
      small_jump: '_doSmallJump',
      chat_ping: '_doChatPing',
    };

    // Resolve the modes list — fall back to all known modes
    this._modes = Array.isArray(this.config.modes) && this.config.modes.length > 0
      ? this.config.modes
      : Object.keys(this._MODE_HANDLERS);

    // Filter to only known modes, keep order from config
    this._modes = this._modes.filter((m) => m in this._MODE_HANDLERS);

    // Ensure at least one valid mode exists
    if (this._modes.length === 0) {
      this._modes = Object.keys(this._MODE_HANDLERS);
    }

    // Resolve the preferred mode
    this._preferredMode = this._resolvePreferredMode(this.config.mode);
  }

  /**
   * Resolve the user-configured preferred mode.
   * If the mode is valid and in the available list, use it exclusively.
   * Otherwise fall back to round-robin rotation through all available modes.
   *
   * @param {string} [mode] - Mode name from config
   * @returns {string|null} The resolved mode, or null for rotation
   */
  _resolvePreferredMode(mode) {
    if (!mode) return null;
    const lower = mode.toLowerCase();
    if (lower in this._MODE_HANDLERS && this._modes.includes(lower)) {
      return lower;
    }
    return null;
  }

  /**
   * Start the anti-AFK loop.
   * Begins executing periodic actions at the configured interval.
   *
   * @returns {boolean} true if started, false if disabled or already running
   */
  start() {
    if (this._timer !== null) {
      this.logger.warn('AntiAFK already started');
      return false;
    }

    if (!this.config.enabled) {
      this.logger.info('AntiAFK disabled by config');
      return false;
    }

    const intervalMs = this.config.interval_ms || 300000;

    this.logger.debug(
      `AntiAFK started — interval=${intervalMs}ms mode=${this._preferredMode || 'rotate(' + this._modes.join(',') + ')'}`
    );

    this._timer = setInterval(() => {
      try {
        this._executeAction();
      } catch (err) {
        this.logger.error(`AntiAFK action failed: ${err.message}`);
      }
    }, intervalMs);

    return true;
  }

  /**
   * Stop the anti-AFK loop.
   * Clears the interval timer. Safe to call multiple times.
   */
  stop() {
    if (this._timer === null) return;

    clearInterval(this._timer);
    this._timer = null;
    this.logger.debug('AntiAFK stopped');
  }

  /**
   * Dynamically change the anti-AFK mode at runtime.
   *
   * @param {string} mode - Mode name to switch to
   * @returns {boolean} true if the mode was accepted
   */
  setMode(mode) {
    const lower = mode.toLowerCase();
    if (!(lower in this._MODE_HANDLERS)) {
      this.logger.warn(`Unknown anti-AFK mode: "${mode}"`);
      return false;
    }

    this._preferredMode = lower;
    this.logger.debug(`AntiAFK mode changed to: ${lower}`);
    return true;
  }

  /**
   * Set to round-robin rotation through all available modes.
   */
  setRotation() {
    this._preferredMode = null;
    this._modeIndex = 0;
    this.logger.debug('AntiAFK set to mode rotation');
  }

  /**
   * Get the currently active mode(s) description.
   *
   * @returns {object} { mode: string, rotating: boolean }
   */
  getStatus() {
    return {
      mode: this._preferredMode || this._modes[this._modeIndex],
      rotating: this._preferredMode === null,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Execute a single anti-AFK action.
   * Uses the preferred mode if set, otherwise round-robins through available modes.
   */
  _executeAction() {
    let mode;

    if (this._preferredMode) {
      mode = this._preferredMode;
    } else {
      mode = this._modes[this._modeIndex];
      this._modeIndex = (this._modeIndex + 1) % this._modes.length;
    }

    const handler = this._MODE_HANDLERS[mode];
    if (!handler) {
      this.logger.warn(`No handler for anti-AFK mode: "${mode}" — skipping`);
      return;
    }

    this.logger.debug(`AntiAFK action: ${mode}`);
    this[handler]();
  }

  /**
   * Look around — vary yaw and pitch slightly so the bot appears to be
   * glancing around its environment. Alternates between two yaw offsets
   * on each tick to create natural-looking head movement.
   */
  _doLookAround() {
    const baseYaw = this.bot.entity.yaw;
    const basePitch = this.bot.entity.pitch;

    // Alternate between swinging left and right of current heading
    const yawOffset = this._lookTick % 2 === 0 ? 0.5 : -0.5;
    // Slight random-ish pitch variation
    const pitchOffset = 0.1 * Math.sin(this._lookTick * 0.5);

    const yaw = baseYaw + yawOffset;
    const pitch = Math.min(Math.max(basePitch + pitchOffset, -Math.PI / 2), Math.PI / 2);

    this.bot.look(yaw, pitch, true);

    this._lookTick++;
  }

  /**
   * Sneak toggle — quickly sneak then unsneak.
   * Sneaking is a low-visibility action that keeps the bot in place.
   */
  _doSneakToggle() {
    this.bot.setControlState('sneak', true);

    // Unsneak after a short delay (100ms is enough to register)
    setTimeout(() => {
      try {
        this.bot.setControlState('sneak', false);
      } catch (err) {
        this.logger.error(`AntiAFK unsneak failed: ${err.message}`);
      }
    }, 100);
  }

  /**
   * Small jump — jump in place briefly.
   * The bot must stay in the stasis chamber, so the jump is brief and
   * the bot does not move forward.
   */
  _doSmallJump() {
    this.bot.setControlState('jump', true);

    setTimeout(() => {
      try {
        this.bot.setControlState('jump', false);
      } catch (err) {
        this.logger.error(`AntiAFK jump release failed: ${err.message}`);
      }
    }, 200);
  }

  /**
   * Chat ping — send a minimal invisible chat packet to show network activity.
   * Sends a single dot ('.') which is virtually invisible in a busy server
   * like 2b2t and will never be noticed in an isolated stasis chamber area.
   */
  _doChatPing() {
    this.bot.chat('.');
  }
}

module.exports = AntiAFK;
