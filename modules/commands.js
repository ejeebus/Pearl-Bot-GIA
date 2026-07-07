/**
 * In-game chat command handler for pearl bot.
 * Listens for !pearl commands from whitelisted players,
 * coordinates with PearlScanner and TrapdoorController.
 */

const EventEmitter = require("events");
const { extractSender, stripSenderPrefix } = require("./chat-utils");

const VALID_MC_NAME = /^[a-zA-Z0-9_]{1,16}$/;
function isValidMinecraftName(name) {
  return typeof name === 'string' && VALID_MC_NAME.test(name);
}

class CommandHandler extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('./whitelist')} whitelist - WhitelistManager instance
   * @param {object} pearlScanner - Must have getPearlForPlayer(name)
   * @param {object} trapdoorController - Must have loadPearl(name, block)
   * @param {import('./recruiter')} recruiter - Recruiter instance
   * @param {import('./logger')} logger - Logger instance
   * @param {object} [options]
   * @param {import('./network')} [options.network] - BotNetwork coordinator (multi-bot routing)
   * @param {import('./pearl-bot')} [options.pearlBot] - The PearlBot that owns this handler
   */
  constructor(bot, whitelist, pearlScanner, trapdoorController, recruiter, logger, options = {}) {
    super();
    this.bot = bot;
    this.whitelist = whitelist;
    this.pearlScanner = pearlScanner;
    this.trapdoorController = trapdoorController;
    this.recruiter = recruiter;
    this.logger = logger;

    // Multi-bot coordination. When `network` is null the handler behaves as a
    // standalone single-bot handler (find on its own scanner, reply itself).
    this.network = options.network || null;
    this.pearlBot = options.pearlBot || null;

    /** @private */ this._listening = false;
    /** @private */ this._lastChatTime = 0;
    /** @private */ this._minChatInterval = 2000;
  }

  /**
   * Whether this handler is the network's single responder for shared replies
   * (not-found messages, aggregated lists, recruitment). Always true in
   * single-bot mode.
   * @private
   */
  _isResponder() {
    return !this.network || this.network.isPrimary(this.pearlBot);
  }

  start() {
    if (this._listening) return;
    this._listening = true;
    this.bot.on("messagestr", this._handleChat);
    this.logger.info("CommandHandler started — listening for !pearl commands");
  }

  stop() {
    if (!this._listening) return;
    this._listening = false;
    this.bot.removeListener("messagestr", this._handleChat);
    this.logger.info("CommandHandler stopped");
  }

  _handleChat = (msg, msgObj, jsonMsg) => {
    const sender = extractSender(msg, jsonMsg);
    if (!sender) return;

    const command = this._parseCommand(msg, sender);
    if (!command) return;

    this.logger.info(
      `Chat command from ${command.sender}: !pearl ${command.target}`
    );

    if (!this.whitelist.isAuthorized(command.sender)) {
      this.logger.warn(
        `Unauthorized !pearl attempt by ${command.sender} (target: ${command.target})`
      );
      return;
    }

    const now = Date.now();
    if (now - this._lastChatTime < this._minChatInterval) {
      this.logger.debug(`Rate limited — skipping response to ${command.sender}`);
      return;
    }

    // !recruit — fire recruitment message immediately.
    // Only the network responder sends, so multiple bots don't all spam it.
    if (command.target === '__recruit') {
      if (!this._isResponder()) return;
      this.recruiter.send();
      this._lastChatTime = now;
      this.logger.info(`Recruitment message triggered by ${command.sender}`);
      return;
    }

    // !pearls — list all tracked pearls. The responder aggregates every
    // chamber's pearls so the requester gets one combined answer.
    if (command.target === '__list') {
      if (!this._isResponder()) return;
      let reply;
      if (this.network) {
        const all = this.network.allKnownPearls();
        reply = all.length
          ? `Tracked: ${all.map((p) => `${p.name} (${p.bot})`).join(', ')}`
          : 'No pearls tracked';
      } else {
        const names = [...this.pearlScanner.getKnownPearls().keys()];
        reply = names.length ? `Tracked: ${names.join(', ')}` : 'No pearls tracked';
      }
      try { this.bot.chat(reply); } catch (err) { this.logger.error(`Chat send failed: ${err.message}`); }
      this._lastChatTime = now;
      this.logger.info(`Pearl list requested by ${command.sender}: ${reply}`);
      return;
    }

    const pearlData = this.pearlScanner.getPearlForPlayer(command.target);

    if (!pearlData) {
      // This bot's chamber doesn't have the pearl. In multi-bot mode, stay
      // silent if another chamber owns it (that bot will respond), and let
      // only the responder announce a genuine "not found".
      if (this.network) {
        if (this.network.findOwner(command.target)) return;
        if (!this._isResponder()) return;
      }
      try { this.bot.chat(`No pearl found for ${command.target}`); } catch (err) { this.logger.error(`Chat send failed: ${err.message}`); }
      this._lastChatTime = now;
      this.logger.info(
        `No pearl found for ${command.target} (requested by ${command.sender})`
      );
      return;
    }

    try { this.bot.chat(`Loading pearl for ${command.target}`); } catch (err) { this.logger.error(`Chat send failed: ${err.message}`); }
    this._lastChatTime = now;

    // Route through the owning PearlBot so the bot pathfinds to the trapdoor and
    // returns to center; fall back to the raw controller in standalone mode.
    (this.pearlBot ?? this.trapdoorController).loadPearl(command.target, pearlData.trapdoorBlock)
      .catch((err) => {
        this.logger.error(`Pearl load failed for ${command.target}: ${err.message}`);
      });

    this.emit("pearl-requested", {
      playerName: command.target,
      source: "chat",
    });

    this.logger.info(
      `Pearl load initiated for ${command.target} by ${command.sender}`
    );
  };

  /**
   * Parse pearl command from message text.
   *
   * Supported formats:
   *   !pearl                     → load sender's own pearl
   *   !pearl <name>              → load pearl for named player
   *   !pearl load                → load sender's own pearl
   *   !pearl load <name>         → load pearl for named player
   *   !loadpearl                 → load sender's own pearl
   *   !loadpearl <name>          → load pearl for named player
   *
   * @param {string} msg  - Raw message text
   * @param {string} sender - Sender username (fallback when no target given)
   * @returns {{ sender: string, target: string } | null}
   */
  _parseCommand(msg, sender) {
    if (typeof msg !== "string") return null;

    // Strip public chat prefix (<Name>) or whisper prefix (Name whispers to you:)
    const text = stripSenderPrefix(msg);

    let match;

    // !recruit — trigger recruitment message immediately
    match = text.match(/^!recruit\s*$/i);
    if (match) return { sender, target: '__recruit' };

    // !pearls — list all tracked pearls
    match = text.match(/^!pearls\s*$/i);
    if (match) return { sender, target: '__list' };

    // !pearl (no args — target self)
    match = text.match(/^!pearl\s*$/i);
    if (match) return { sender, target: sender };

    // !pearl load [playerName]
    match = text.match(/^!pearl\s+load(?:\s+(.+))?$/i);
    if (match) {
      const target = match[1] ? match[1].trim() : sender;
      if (!isValidMinecraftName(target)) return null;
      return { sender, target };
    }

    // !pearl <playerName>
    match = text.match(/^!pearl\s+(.+)$/i);
    if (match) {
      const target = match[1].trim();
      if (!isValidMinecraftName(target)) return null;
      return { sender, target };
    }

    // !loadpearl [playerName]
    match = text.match(/^!loadpearl\s+(.+)$/i);
    if (match) {
      const target = match[1].trim();
      if (!isValidMinecraftName(target)) return null;
      return { sender, target };
    }

    // !loadpearl (no args — target self)
    match = text.match(/^!loadpearl\s*$/i);
    if (match) return { sender, target: sender };

    return null;
  }
}

module.exports = CommandHandler;
