/**
 * QueueMonitor — live 2b2t queue position tracking + rich logging.
 *
 * 2b2t does NOT announce your queue position in chat. It renders it in the
 * player-list *footer* (the header/footer of the tab menu), refreshed ~once a
 * second. That text arrives via the `playerlist_header` packet, which fires
 * during the queue — i.e. BEFORE the bot spawns into the game. This monitor is
 * therefore attached in createBot() (pre-spawn), not from QueueHandler (which
 * only wires up post-spawn and would miss the entire queue).
 *
 * Behaviour:
 *   - Logs a line whenever the position changes, plus a heartbeat every
 *     `heartbeat_ms` so the log proves the bot is alive during static stretches.
 *   - Rich line: current position, delta, movement rate, and an ETA estimated
 *     from that rate (falling back to 2b2t's own ETA text when rate is unknown).
 *   - Warns (once) if the position hasn't advanced for `stuck_timeout_ms`,
 *     which usually means a 2b2t restart or a frozen queue.
 *
 * Events:
 *   'queue-update'   { position, eta, rate }  — on first sight + each change
 *   'queue-stuck'    { position, stalledMs }  — when the queue appears frozen
 *   'queue-complete' ()                       — reached the front / spawned in
 *
 * Config (config.queue):
 *   queue_heartbeat_ms      number  (default 60000, 0 disables heartbeat)
 *   queue_stuck_timeout_ms  number  (default 900000, 0 disables stuck warning)
 */

const EventEmitter = require('events');

const HISTORY_WINDOW_MS = 10 * 60 * 1000; // rate is averaged over the last 10 min

class QueueMonitor extends EventEmitter {
  constructor(config, logger) {
    super();
    const qc = (config && config.queue) || {};
    this._logger = logger;
    this._heartbeatMs = qc.queue_heartbeat_ms ?? 60000;
    this._stuckMs = qc.queue_stuck_timeout_ms ?? 900000;

    this._bot = null;
    this._client = null;
    this._onHeader = this._onHeader.bind(this);

    this._reset();
  }

  _reset() {
    this._position = null;
    this._eta = null;
    this._history = []; // [{ t, pos }]
    this._lastProgressAt = Date.now();
    this._stuckWarned = false;
    this._clearTimers();
  }

  _clearTimers() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Attach to a freshly created bot. Call this in createBot() BEFORE spawn so
   * the monitor sees the queue from the start.
   * @param {import('mineflayer').Bot} bot
   */
  attach(bot) {
    this.detach();
    this._bot = bot;
    this._client = bot._client;
    this._client.on('playerlist_header', this._onHeader);
  }

  detach() {
    if (this._client) {
      this._client.removeListener('playerlist_header', this._onHeader);
    }
    this._client = null;
    this._bot = null;
    this._reset();
  }

  /** Call when the bot spawns into the actual game (queue finished). */
  onSpawn() {
    if (this._position != null) {
      this._logger.info('[QUEUE] Reached the front — connecting to the server');
      this.emit('queue-complete');
    }
    this._reset();
  }

  stop() {
    this.detach();
  }

  /**
   * Read the tab header+footer as plain text. We go through mineflayer's parsed
   * `bot.tablist` (prismarine-chat) rather than the raw packet so we don't have
   * to care whether the server sent the component as legacy JSON or 1.20.3+ NBT.
   */
  _footerText() {
    try {
      const tl = this._bot && this._bot.tablist;
      if (!tl) return '';
      const header = tl.header ? tl.header.toString() : '';
      const footer = tl.footer ? tl.footer.toString() : '';
      return `${header}\n${footer}`;
    } catch {
      return '';
    }
  }

  _onHeader() {
    const text = this._footerText();
    if (!text) return;

    // 2b2t has used both "Position:" and "Position in queue:" over time.
    const posMatch = text.match(/position(?:\s*in\s*queue)?\s*:?\s*#?(\d+)/i);
    if (!posMatch) return;
    const pos = parseInt(posMatch[1], 10);
    if (!Number.isFinite(pos)) return;

    // Likewise "Queue ETA:" and "Estimated time:".
    const etaMatch = text.match(/(?:queue\s*eta|estimated\s*time)\s*:?\s*([^\n]+)/i);
    const eta = etaMatch ? etaMatch[1].trim() : null;

    this._update(pos, eta);
  }

  _update(pos, eta) {
    const now = Date.now();
    const prev = this._position;
    this._position = pos;
    this._eta = eta;

    this._history.push({ t: now, pos });
    const cutoff = now - HISTORY_WINDOW_MS;
    while (this._history.length > 2 && this._history[0].t < cutoff) {
      this._history.shift();
    }

    if (prev != null && pos < prev) {
      this._lastProgressAt = now;
      this._stuckWarned = false;
    }

    if (prev == null) {
      this._logger.info(
        `[QUEUE] In queue — position ${pos}${eta ? `, server ETA ${eta}` : ''}`
      );
      this._startHeartbeat();
      this.emit('queue-update', { position: pos, eta, rate: null });
    } else if (pos !== prev) {
      this._logPosition(pos, prev, eta);
      this.emit('queue-update', { position: pos, eta, rate: this._rate() });
    }

    this._checkStuck(now);
  }

  /** Positions advanced per minute over the history window, or null if unknown. */
  _rate() {
    if (this._history.length < 2) return null;
    const first = this._history[0];
    const last = this._history[this._history.length - 1];
    const advanced = first.pos - last.pos; // queue counts down
    const minutes = (last.t - first.t) / 60000;
    if (minutes <= 0 || advanced <= 0) return null;
    return advanced / minutes;
  }

  _fmtDuration(mins) {
    if (!Number.isFinite(mins) || mins < 0) return null;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  }

  /**
   * @param {number} pos    current position
   * @param {number|null} prev  previous position (null = heartbeat, no delta shown)
   * @param {string|null} serverEta  2b2t's own ETA text, used as a fallback
   */
  _logPosition(pos, prev, serverEta) {
    const parts = [`Position: ${pos}`];

    if (prev != null) {
      const delta = pos - prev; // negative = progress
      parts.push(delta === 0 ? '±0' : delta < 0 ? `${delta}` : `+${delta}`);
    }

    const rate = this._rate();
    if (rate) {
      parts.push(`~${rate.toFixed(1)}/min`);
      const eta = this._fmtDuration(pos / rate);
      if (eta) parts.push(`ETA ~${eta}`);
    } else if (serverEta) {
      parts.push(`ETA ~${serverEta}`);
    }

    this._logger.info(`[QUEUE] ${parts.join('  ')}`);
  }

  _startHeartbeat() {
    this._clearTimers();
    if (this._heartbeatMs > 0) {
      this._heartbeatTimer = setInterval(() => {
        if (this._position != null) {
          this._logPosition(this._position, null, this._eta);
          this._checkStuck(Date.now());
        }
      }, this._heartbeatMs);
      if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
    }
  }

  _checkStuck(now) {
    if (this._position == null || this._stuckMs <= 0 || this._stuckWarned) return;
    if (now - this._lastProgressAt > this._stuckMs) {
      this._stuckWarned = true;
      const mins = Math.round((now - this._lastProgressAt) / 60000);
      this._logger.warn(
        `[QUEUE] Position stuck at ${this._position} for ${mins}m — ` +
          `queue may be frozen (2b2t restart or queue hiccup)`
      );
      this.emit('queue-stuck', {
        position: this._position,
        stalledMs: now - this._lastProgressAt,
      });
    }
  }
}

module.exports = QueueMonitor;
