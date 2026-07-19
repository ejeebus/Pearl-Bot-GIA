/**
 * RubberBandGuard - Detects and dampens server-side position rejection
 * ("rubber-banding") for a single bot.
 *
 * On 2b2t, when the client/server position desyncs the server teleports the bot
 * back on every tick. Mineflayer surfaces each of those corrections as a
 * `forcedMove` event (~20/sec while it lasts). Left unchecked this is doubly
 * harmful:
 *
 *   1. LOG FLOOD — one WARN per tick buries every other line in the log.
 *   2. STUCK BOT — every tick the physics engine re-sends the movement the
 *      server just rejected, so the bot is frozen server-side and the
 *      pathfinder can never walk to a trapdoor to pull a pearl.
 *
 * A version/protocol mismatch after a 2b2t update is the usual trigger (the
 * telltale sign is a plausible Y but nonsensical X/Z in the reposition target —
 * the position packet's relative-movement flags are being mistranslated). The
 * real cure is pinning the client `version` in config.json to 2b2t's current
 * native version, but this guard keeps the bot stable and self-healing in the
 * meantime instead of spamming and spinning.
 *
 * What it does:
 *   - Throttles the warning: logs the first event, then a periodic summary
 *     ("N rubber-bands in the last Xs") rather than one line per tick.
 *   - When rubber-banding is sustained (>= burst_threshold events within
 *     burst_window_ms), declares the bot DESYNCED: disables physics, clears
 *     control states and cancels any pathfinder goal so the bot stops sending
 *     rejected movement packets. That breaks the fight loop at its source — and
 *     with it the log flood.
 *   - While desynced, watches for quiet: once no reposition has arrived for
 *     recover_quiet_ms it re-enables physics and clears the desync flag.
 *   - If the desync persists past reconnect_after_ms it escalates ONCE (behind a
 *     reconnect_cooldown_ms cooldown) to a reconnect — the only reliable cure
 *     for a hard position desync — gated so it can never tight-loop reconnects.
 *
 * Emits:
 *   'desync'  ()  — entered the sustained-rubber-band state (physics paused)
 *   'resync'  ()  — recovered; physics re-enabled
 *
 * Config (config.rubber_band, all optional):
 *   enabled               boolean (default true)
 *   burst_threshold       number  (default 5)
 *   burst_window_ms       number  (default 3000)
 *   summary_interval_ms   number  (default 30000)
 *   recover_quiet_ms      number  (default 5000)
 *   auto_reconnect        boolean (default true)
 *   reconnect_after_ms    number  (default 180000)
 *   reconnect_cooldown_ms number  (default 600000)
 */

const EventEmitter = require('events');

const DEFAULTS = {
  enabled: true,
  burst_threshold: 5,
  burst_window_ms: 3000,
  summary_interval_ms: 30000,
  recover_quiet_ms: 5000,
  auto_reconnect: true,
  reconnect_after_ms: 180000,
  reconnect_cooldown_ms: 600000,
};

class RubberBandGuard extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} config - full per-bot config (reads config.rubber_band)
   * @param {object} logger - already tagged with the bot name
   * @param {function(string):void} [requestReconnect] - forces a reconnect (e.g. bot.quit)
   */
  constructor(bot, config, logger, requestReconnect) {
    super();
    this.bot = bot;
    this.logger = logger;
    this.requestReconnect = requestReconnect;

    const cfg = (config && config.rubber_band) || {};
    this.enabled = cfg.enabled !== false && DEFAULTS.enabled;
    this.burstThreshold = cfg.burst_threshold ?? DEFAULTS.burst_threshold;
    this.burstWindowMs = cfg.burst_window_ms ?? DEFAULTS.burst_window_ms;
    this.summaryIntervalMs = cfg.summary_interval_ms ?? DEFAULTS.summary_interval_ms;
    this.recoverQuietMs = cfg.recover_quiet_ms ?? DEFAULTS.recover_quiet_ms;
    this.autoReconnect = cfg.auto_reconnect !== false && DEFAULTS.auto_reconnect;
    this.reconnectAfterMs = cfg.reconnect_after_ms ?? DEFAULTS.reconnect_after_ms;
    this.reconnectCooldownMs = cfg.reconnect_cooldown_ms ?? DEFAULTS.reconnect_cooldown_ms;

    this.desynced = false;

    // Sliding-window event timestamps (trimmed to burstWindowMs on each event).
    this._hits = [];
    // Count of warnings suppressed since the last summary emit.
    this._suppressed = 0;
    this._lastForcedMove = 0;
    this._desyncStart = 0;
    this._lastReconnect = 0;
    this._summaryTimer = null;
    this._recoverTimer = null;
    this._active = false;

    this._onForcedMove = this._onForcedMove.bind(this);
  }

  start() {
    if (!this.enabled || this._active) return;
    this._active = true;
    this.bot.on('forcedMove', this._onForcedMove);
  }

  stop() {
    this._active = false;
    try { this.bot.off('forcedMove', this._onForcedMove); } catch { /* noop */ }
    this._clearTimers();
    this._hits = [];
    this._suppressed = 0;
    this.desynced = false;
  }

  isDesynced() {
    return this.desynced;
  }

  _clearTimers() {
    if (this._summaryTimer) { clearTimeout(this._summaryTimer); this._summaryTimer = null; }
    if (this._recoverTimer) { clearInterval(this._recoverTimer); this._recoverTimer = null; }
  }

  _posStr() {
    try { return String(this.bot.entity.position.floored()); }
    catch { return 'unknown'; }
  }

  _onForcedMove() {
    const now = Date.now();
    this._lastForcedMove = now;

    // Trim the sliding window and record this event.
    const cutoff = now - this.burstWindowMs;
    this._hits = this._hits.filter((t) => t >= cutoff);
    this._hits.push(now);

    if (this.desynced) {
      // Still storming. Something re-enabled physics (e.g. a config->play state
      // transition) — re-assert the pause so we don't resume the fight loop.
      if (this.bot.physicsEnabled) {
        try { this.bot.physicsEnabled = false; } catch { /* noop */ }
        try { this.bot.clearControlStates(); } catch { /* noop */ }
      }
      return;
    }

    // First event of a (possibly transient) burst: log it, then coalesce the
    // rest into a periodic summary instead of one line per tick.
    if (!this._summaryTimer) {
      this.logger.warn(
        `Server repositioned bot to ${this._posStr()} (movement rejected / rubber-band)`
      );
      this._suppressed = 0;
      this._summaryTimer = setTimeout(() => this._emitSummary(), this.summaryIntervalMs);
      if (this._summaryTimer.unref) this._summaryTimer.unref();
    } else {
      this._suppressed++;
    }

    // Sustained rubber-banding => break the fight loop.
    if (this._hits.length >= this.burstThreshold) {
      this._enterDesync();
    }
  }

  _emitSummary() {
    this._summaryTimer = null;
    if (this._suppressed > 0) {
      this.logger.warn(
        `Rubber-band: ${this._suppressed} further reposition(s) in the last ` +
        `${Math.round(this.summaryIntervalMs / 1000)}s (latest ${this._posStr()})`
      );
    }
    this._suppressed = 0;
  }

  _enterDesync() {
    this.desynced = true;
    this._desyncStart = Date.now();
    if (this._summaryTimer) { clearTimeout(this._summaryTimer); this._summaryTimer = null; }
    this._suppressed = 0;

    this.logger.warn(
      `Sustained rubber-banding (>= ${this.burstThreshold} in ${Math.round(this.burstWindowMs / 1000)}s) — ` +
      `pausing movement (physics off) to break the desync loop. Likely a client/server ` +
      `version mismatch; pin config.json "version" to 2b2t's current version to cure it.`
    );

    // Stop feeding the loop: no more movement packets for the server to reject.
    try { this.bot.pathfinder?.setGoal(null); } catch { /* noop */ }
    try { this.bot.clearControlStates(); } catch { /* noop */ }
    try { this.bot.physicsEnabled = false; } catch { /* noop */ }

    this.emit('desync');

    // Watch for recovery / decide whether to escalate to a reconnect.
    this._recoverTimer = setInterval(() => this._checkRecovery(), 1000);
    if (this._recoverTimer.unref) this._recoverTimer.unref();
  }

  _checkRecovery() {
    if (!this.desynced) return;
    const now = Date.now();

    // Quiet for long enough: the storm has passed — resume normal operation.
    if (now - this._lastForcedMove >= this.recoverQuietMs) {
      this._exitDesync();
      return;
    }

    // Still storming after too long: a hard desync. Reconnecting re-establishes
    // position sync — the only reliable cure. Gated by a cooldown so it can
    // never tight-loop.
    if (
      this.autoReconnect &&
      now - this._desyncStart >= this.reconnectAfterMs &&
      now - this._lastReconnect >= this.reconnectCooldownMs &&
      typeof this.requestReconnect === 'function'
    ) {
      this._lastReconnect = now;
      this.logger.warn(
        `Rubber-banding persisted ${Math.round((now - this._desyncStart) / 1000)}s — ` +
        `reconnecting to re-sync position.`
      );
      // The reconnect tears down this bot; stop watching it here.
      this._clearTimers();
      this.desynced = false;
      try { this.requestReconnect('Rubber-band desync recovery'); } catch { /* noop */ }
    }
  }

  _exitDesync() {
    this.desynced = false;
    this._clearTimers();
    this._hits = [];
    this._suppressed = 0;
    try { this.bot.physicsEnabled = true; } catch { /* noop */ }
    this.logger.info('Rubber-banding subsided — movement re-enabled.');
    this.emit('resync');
  }
}

module.exports = RubberBandGuard;
