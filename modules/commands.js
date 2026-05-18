/**
 * In-game chat command handler for pearl bot.
 * Listens for !pearl commands from whitelisted players,
 * coordinates with PearlScanner and TrapdoorController.
 */

const EventEmitter = require("events");

class CommandHandler extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {import('./whitelist')} whitelist - WhitelistManager instance
   * @param {object} pearlScanner - Must have getPearlForPlayer(name)
   * @param {object} trapdoorController - Must have loadPearl(name, block)
   * @param {import('./logger')} logger - Logger instance
   */
  constructor(bot, whitelist, pearlScanner, trapdoorController, logger) {
    super();
    this.bot = bot;
    this.whitelist = whitelist;
    this.pearlScanner = pearlScanner;
    this.trapdoorController = trapdoorController;
    this.logger = logger;

    /** @private */ this._listening = false;
    /** @private */ this._lastChatTime = 0;
    /** @private */ this._minChatInterval = 2000;
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
    const sender = this._extractSender(msg, jsonMsg);
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

    const pearlData = this.pearlScanner.getPearlForPlayer(command.target);

    if (!pearlData) {
      this.bot.chat(`No pearl found for ${command.target}`);
      this._lastChatTime = now;
      this.logger.info(
        `No pearl found for ${command.target} (requested by ${command.sender})`
      );
      return;
    }

    this.bot.chat(`Loading pearl for ${command.target}`);
    this._lastChatTime = now;

    this.trapdoorController.loadPearl(command.target, pearlData.trapdoorBlock)
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
   * Try to extract the chat sender's username from the message.
   * Priority: jsonMsg structured data > plain-text <PlayerName> pattern.
   *
   * @param {string} msg - Plain text of the message
   * @param {object} jsonMsg - Mineflayer ChatMessage object (or similar)
   * @returns {string|null}
   */
  _extractSender(msg, jsonMsg) {
    // Attempt structured extraction from Mineflayer ChatMessage
    try {
      if (jsonMsg?.json?.translate === "chat.type.text") {
        const withData = jsonMsg.json.with;
        if (Array.isArray(withData)) {
          // Pre-1.19:  ["PlayerName", " message text"]
          if (withData.length >= 2 && withData[0]?.text) {
            return withData[0].text;
          }
          // 1.19+: ["<PlayerName> message text"]
          if (withData.length === 1) {
            const content =
              typeof withData[0] === "object"
                ? withData[0].text
                : String(withData[0]);
            const match = content.match(/^<([^>]+?)>\s/);
            if (match) return match[1];
          }
        }
      }
    } catch {
      // jsonMsg structure may vary — fall through to text parsing
    }

    // Fallback: plain text <PlayerName> pattern
    if (typeof msg === "string") {
      const match = msg.match(/^<([^>]+?)>\s/);
      if (match) return match[1];
    }

    return null;
  }

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

    // Strip leading <SenderName> prefix if present
    const text = msg.replace(/^<[^>]+?>\s*/, "");

    let match;

    // !pearl (no args — target self)
    match = text.match(/^!pearl\s*$/i);
    if (match) return { sender, target: sender };

    // !pearl load [playerName]
    match = text.match(/^!pearl\s+load(?:\s+(.+))?$/i);
    if (match) {
      return {
        sender,
        target: match[1] ? match[1].trim() : sender,
      };
    }

    // !pearl <playerName>
    match = text.match(/^!pearl\s+(.+)$/i);
    if (match) return { sender, target: match[1].trim() };

    // !loadpearl [playerName]
    match = text.match(/^!loadpearl\s+(.+)$/i);
    if (match) return { sender, target: match[1].trim() };

    // !loadpearl (no args — target self)
    match = text.match(/^!loadpearl\s*$/i);
    if (match) return { sender, target: sender };

    return null;
  }
}

module.exports = CommandHandler;
