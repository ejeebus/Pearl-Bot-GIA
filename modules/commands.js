/**
 * In-game chat command handler for pearl bot.
 * Listens for !pearl commands from whitelisted players,
 * coordinates with PearlScanner and TrapdoorController.
 */

const EventEmitter = require("events");

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
   */
  constructor(bot, whitelist, pearlScanner, trapdoorController, recruiter, logger) {
    super();
    this.bot = bot;
    this.whitelist = whitelist;
    this.pearlScanner = pearlScanner;
    this.trapdoorController = trapdoorController;
    this.recruiter = recruiter;
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

    // !recruit — fire recruitment message immediately
    if (command.target === '__recruit') {
      this.recruiter.send();
      this._lastChatTime = now;
      this.logger.info(`Recruitment message triggered by ${command.sender}`);
      return;
    }

    // !pearls — list all tracked pearls for debugging
    if (command.target === '__list') {
      const known = this.pearlScanner.getKnownPearls();
      const names = [...known.keys()];
      const reply = names.length ? `Tracked: ${names.join(', ')}` : 'No pearls tracked';
      try { this.bot.chat(reply); } catch (err) { this.logger.error(`Chat send failed: ${err.message}`); }
      this._lastChatTime = now;
      this.logger.info(`Pearl list requested by ${command.sender}: ${reply}`);
      return;
    }

    const pearlData = this.pearlScanner.getPearlForPlayer(command.target);

    if (!pearlData) {
      try { this.bot.chat(`No pearl found for ${command.target}`); } catch (err) { this.logger.error(`Chat send failed: ${err.message}`); }
      this._lastChatTime = now;
      this.logger.info(
        `No pearl found for ${command.target} (requested by ${command.sender})`
      );
      return;
    }

    try { this.bot.chat(`Loading pearl for ${command.target}`); } catch (err) { this.logger.error(`Chat send failed: ${err.message}`); }
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

      // Whisper (1.19+): translate key "commands.message.display.incoming"
      // with[0] = sender name, with[1] = message body
      if (jsonMsg?.json?.translate === "commands.message.display.incoming") {
        const withData = jsonMsg.json.with;
        if (Array.isArray(withData) && withData.length >= 1) {
          const s = withData[0];
          const name = typeof s === "string" ? s : (s?.text ?? s?.insertion);
          if (name) return name;
        }
      }
    } catch {
      // jsonMsg structure may vary — fall through to text parsing
    }

    if (typeof msg === "string") {
      // Public chat fallback: <PlayerName> message
      const pubMatch = msg.match(/^<([^>]+?)>\s/);
      if (pubMatch) return pubMatch[1];

      // Whisper fallback: "PlayerName whispers: message" or "PlayerName whispers to you: message"
      const whisperMatch = msg.match(/^([a-zA-Z0-9_]{1,16}) whispers(?: to you)?:/);
      if (whisperMatch) return whisperMatch[1];
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

    // Strip public chat prefix (<Name>) or whisper prefix (Name whispers to you:)
    const text = msg
      .replace(/^<[^>]+?>\s*/, "")
      .replace(/^[a-zA-Z0-9_]{1,16} whispers(?: to you)?:\s*/, "");

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
