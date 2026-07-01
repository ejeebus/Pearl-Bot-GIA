/**
 * QueueHandler - Handles automatic reconnection and 2b2t queue management.
 *
 * Events:
 *   'reconnecting'         { attempt: number, delay: number }
 *   'reconnected'          (bot) — new bot instance after successful join
 *   'max-attempts-reached' — all retries exhausted
 *
 * Config (config.queue):
 *   auto_reconnect            boolean  (default true)
 *   max_reconnect_attempts    number   (0 = infinite, default 0)
 *   reconnect_delay_base_ms   number   (default 30000)
 *   reconnect_delay_max_ms    number   (default 600000)
 *   duplicate_session_delay_ms number  (default 60000) — fixed wait used when
 *     kicked for an "already connected" / stale-session reason, instead of
 *     the normal exponential backoff.
 */

const EventEmitter = require('events');

class QueueHandler extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot - Current Mineflayer bot instance
   * @param {object} config - Full bot configuration (uses config.queue)
   * @param {function(): import('mineflayer').Bot} createBotFn - Factory that creates a new bot
   * @param {object} logger - Logger with .info(), .warn(), .error(), .debug(), .chat() methods
   */
  constructor(bot, config, createBotFn, logger) {
    super();
    this.bot = bot;
    this.config = config;
    this.createBotFn = createBotFn;
    this.logger = logger;

    const qc = config.queue || {};
    this._autoReconnect =
      qc.auto_reconnect !== undefined ? qc.auto_reconnect : true;
    this._maxAttempts =
      qc.max_reconnect_attempts !== undefined ? qc.max_reconnect_attempts : 0;
    this._baseDelay = qc.reconnect_delay_base_ms || 30000;
    this._maxDelay = qc.reconnect_delay_max_ms || 600000;
    this._duplicateSessionDelay = qc.duplicate_session_delay_ms || 60000;

    this._reconnecting = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._stopped = false;

    this._onEnd = this._onEnd.bind(this);
    this._onKicked = this._onKicked.bind(this);
    this._onSpawn = this._onSpawn.bind(this);
  }

  start() {
    this._stopped = false;
    this._cancelReconnect();
    if (this.bot) {
      this._detachHandlers(this.bot);
      this._attachHandlers(this.bot);
    }
  }

  stop() {
    this._stopped = true;
    this._cancelReconnect();
    if (this.bot) {
      this._detachHandlers(this.bot);
    }
  }

  _attachHandlers(botInstance) {
    botInstance.on('end', this._onEnd);
    botInstance.on('kicked', this._onKicked);
  }

  _detachHandlers(botInstance) {
    botInstance.removeListener('end', this._onEnd);
    botInstance.removeListener('kicked', this._onKicked);
    botInstance.removeListener('spawn', this._onSpawn);
  }

  _cancelReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _onEnd(reason) {
    this.logger.warn(`Bot disconnected: ${reason || 'unknown reason'}`);
    this._handleDisconnect();
  }

  _onKicked(reason, loggedIn) {
    const reasonStr =
      typeof reason === 'string' ? reason : JSON.stringify(reason);
    this.logger.warn(`Bot was kicked: ${reasonStr}`);

    // 2b2t's Velocity proxy kicks with this when a previous session hasn't
    // timed out yet. Retrying on the normal (short) backoff just re-triggers
    // the same kick, so force a longer fixed wait for the stale session to clear.
    const isDuplicateSession = /already connected|duplicate.?login|already online/i.test(reasonStr);
    this._handleDisconnect(isDuplicateSession ? this._duplicateSessionDelay : null);
  }

  /**
   * Uses _reconnecting to prevent stacking when kicked+end fire in sequence.
   * @param {number|null} forcedDelay - If set, use this delay instead of the computed backoff.
   */
  _handleDisconnect(forcedDelay = null) {
    if (this._reconnecting || this._stopped) return;

    this._reconnecting = true;
    this._attempt++;

    if (!this._autoReconnect) {
      this.logger.info('Auto-reconnect is disabled, will not reconnect');
      this._reconnecting = false;
      return;
    }

    if (this._maxAttempts > 0 && this._attempt > this._maxAttempts) {
      this.logger.error(
        `Max reconnect attempts (${this._maxAttempts}) reached. Giving up.`
      );
      this._reconnecting = false;
      this.emit('max-attempts-reached');
      return;
    }

    this._scheduleReconnect(forcedDelay);
  }

  _scheduleReconnect(forcedDelay = null) {
    let delay;
    if (forcedDelay != null) {
      delay = forcedDelay;
      this.logger.info(
        `Scheduling reconnect attempt ${this._attempt} in ${(delay / 1000).toFixed(1)}s ` +
          `(fixed delay — stale session on proxy)`
      );
    } else {
      const rawDelay = this._baseDelay * Math.pow(1.5, this._attempt - 1);
      const clampedDelay = Math.min(rawDelay, this._maxDelay);

      // Jitter: +/- 20% uniform random
      const jitterFactor = 1 + (Math.random() * 0.4 - 0.2);
      delay = Math.round(clampedDelay * jitterFactor);

      this.logger.info(
        `Scheduling reconnect attempt ${this._attempt} in ` +
          `${(delay / 1000).toFixed(1)}s ` +
          `(base: ${this._baseDelay}ms, ` +
          `raw: ${Math.round(rawDelay)}ms, ` +
          `jittered: ${delay}ms)`
      );
    }

    this.emit('reconnecting', { attempt: this._attempt, delay });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._doReconnect();
    }, delay);
  }

  _doReconnect() {
    if (this._stopped) {
      this._reconnecting = false;
      return;
    }

    this.logger.info(`Reconnect attempt ${this._attempt} starting...`);

    let newBot;
    try {
      newBot = this.createBotFn();
    } catch (err) {
      this.logger.error(
        `Reconnect attempt ${this._attempt} FAILED: ${err.message}`
      );
      this._scheduleReconnect();
      return;
    }

    if (!newBot) {
      this.logger.error(
        `Reconnect attempt ${this._attempt} FAILED: createBotFn returned null/undefined`
      );
      this._scheduleReconnect();
      return;
    }

    this.logger.info(
      `Reconnect attempt ${this._attempt}: new bot instance created`
    );

    if (this.bot) {
      this._detachHandlers(this.bot);
    }

    this.bot = newBot;

    this._attachHandlers(this.bot);
    this.bot.once('spawn', this._onSpawn);

    // Allow new bot disconnect events to trigger a fresh cycle (e.g. auth rejected)
    this._reconnecting = false;
  }

  _onSpawn() {
    this.logger.info('Bot successfully joined the server');
    this._attempt = 0;
    this.emit('reconnected', this.bot);
  }
}

module.exports = QueueHandler;
