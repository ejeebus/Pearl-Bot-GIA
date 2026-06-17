/**
 * ChatLogger - Records every chat message seen by the bot (public chat,
 * whispers directed at the bot, etc.) into a local SQLite database for
 * later review — vetting players, investigating incidents, searching
 * for specific phrases, and so on.
 *
 * Also supports keyword flagging: messages matching configured keywords
 * are logged at WARN level and optionally relayed to Discord immediately.
 *
 * Config (config.chat_logging):
 *   enabled        boolean   (default true)
 *   db_path         string    (default "chat-log.db")
 *   flag_keywords  string[]  (default []） — case-insensitive substrings/words
 *
 * Uses Node's built-in `node:sqlite` (experimental, available Node 22.5+).
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { extractSender, stripSenderPrefix } = require('./chat-utils');

class ChatLogger {
  /**
   * Note: this does NOT take a bot in the constructor — the SQLite connection
   * is opened once and kept alive across reconnects. Call bind(bot) each time
   * the underlying bot instance changes (e.g. after a reconnect).
   *
   * @param {object} config - Full app config (reads config.chat_logging)
   * @param {object} logger - Logger instance
   * @param {object} [discordBot] - Optional DiscordBot instance for keyword alerts (must expose sendToChannel)
   */
  constructor(config, logger, discordBot = null) {
    this.bot = null;
    this.logger = logger;
    this.discordBot = discordBot;

    const cfg = config.chat_logging || {};
    this.enabled = cfg.enabled !== false;
    this.dbPath = cfg.db_path || 'chat-log.db';
    this.flagKeywords = (cfg.flag_keywords || []).map((k) => k.toLowerCase());

    this._listening = false;
    this._handleMessage = this._handleMessage.bind(this);

    if (this.enabled) {
      this._openDb();
    }
  }

  /**
   * Attach the message listener to a (possibly new) bot instance, detaching
   * from the previous one first. Safe to call repeatedly across reconnects.
   */
  bind(bot) {
    if (this.bot === bot) return;
    if (this.bot) {
      this.bot.removeListener('messagestr', this._handleMessage);
    }
    this.bot = bot;
    if (this.enabled && this._listening) {
      this.bot.on('messagestr', this._handleMessage);
    }
  }

  _openDb() {
    this.db = new DatabaseSync(path.resolve(this.dbPath));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        sender TEXT,
        message TEXT NOT NULL,
        flagged INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);

    this._insertStmt = this.db.prepare(
      'INSERT INTO messages (timestamp, sender, message, flagged) VALUES (?, ?, ?, ?)'
    );

    this.logger.info(`ChatLogger: database ready at ${path.resolve(this.dbPath)}`);
  }

  start() {
    if (!this.enabled) {
      this.logger.info('ChatLogger disabled in config');
      return;
    }
    if (this._listening) return;
    this._listening = true;
    if (this.bot) this.bot.on('messagestr', this._handleMessage);
    this.logger.info('ChatLogger started — recording all chat to database');
  }

  stop() {
    if (!this._listening) return;
    this._listening = false;
    if (this.bot) this.bot.removeListener('messagestr', this._handleMessage);
  }

  /** Close the database handle. Call during graceful shutdown. */
  close() {
    this.stop();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  _handleMessage(msg, msgObj, jsonMsg) {
    if (typeof msg !== 'string' || !msg) return;

    const sender = extractSender(msg, jsonMsg);
    const body = sender ? stripSenderPrefix(msg) : msg;
    const flagged = this._matchesKeyword(body);

    try {
      this._insertStmt.run(new Date().toISOString(), sender, body, flagged ? 1 : 0);
    } catch (err) {
      this.logger.error(`ChatLogger: failed to write message: ${err.message}`);
    }

    if (flagged) {
      this.logger.warn(`ChatLogger: flagged message from ${sender ?? 'unknown'}: ${body}`);
      if (this.discordBot) {
        this.discordBot
          .sendToChannel(`🚩 Flagged message from **${sender ?? 'unknown'}**: ${body}`)
          .catch(() => {});
      }
    }
  }

  _matchesKeyword(body) {
    if (this.flagKeywords.length === 0) return false;
    const lower = body.toLowerCase();
    return this.flagKeywords.some((kw) => lower.includes(kw));
  }

  /**
   * Search logged messages. Useful from a REPL or a small CLI script.
   * @param {object} opts
   * @param {string} [opts.sender] - Exact sender match (case-insensitive)
   * @param {string} [opts.contains] - Substring to search for in message text
   * @param {boolean} [opts.flaggedOnly] - Only return flagged messages
   * @param {number} [opts.limit] - Max rows to return (default 100)
   * @returns {Array<{id:number, timestamp:string, sender:string|null, message:string, flagged:number}>}
   */
  search({ sender, contains, flaggedOnly, limit = 100 } = {}) {
    const clauses = [];
    const params = [];

    if (sender) {
      clauses.push('LOWER(sender) = LOWER(?)');
      params.push(sender);
    }
    if (contains) {
      clauses.push('message LIKE ?');
      params.push(`%${contains}%`);
    }
    if (flaggedOnly) {
      clauses.push('flagged = 1');
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare(
      `SELECT id, timestamp, sender, message, flagged FROM messages ${where} ORDER BY id DESC LIMIT ?`
    );
    return stmt.all(...params, limit);
  }
}

module.exports = ChatLogger;
