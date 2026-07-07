/**
 * Discord bot module for the Mineflayer pearl bot.
 *
 * Listens for `!pearl <playerName>` in a configured Discord channel,
 * verifies the Discord user is whitelisted, finds the player's stasis
 * pearl via the pearlScanner, triggers the trapdoor mechanism to load
 * them, and responds with a rich embed.
 *
 * Dependencies (injected via constructor):
 *   - config            — full app config (reads config.discord.*)
 *   - whitelist         — WhitelistManager instance (isAuthorized)
 *   - pearlScanner      — scanner with getPearlForPlayer(name) method
 *   - trapdoorController — controller with loadPearl(name, block) method
 *   - logger            — Logger instance
 *
 * Requires discord.js v14.
 */

const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const COLORS = {
  SUCCESS: 0x57f287,
  ERROR: 0xed4245,
  DENIED: 0xfee75c,
  INFO: 0x5865f2,
  ALERT: 0xff6600,
};

class DiscordBot {
  /**
   * @param {object}   config            Full app configuration
   * @param {object}   whitelist         WhitelistManager instance
   * @param {object}   pearlScanner      Pearl scanner instance
   * @param {object}   trapdoorController Trapdoor controller instance
   * @param {object}   logger            Logger instance
   */
  constructor(config, whitelist, pearlScanner, trapdoorController, logger) {
    this.config = config;
    this.whitelist = whitelist;
    this.pearlScanner = pearlScanner;
    this.trapdoorController = trapdoorController;
    this.logger = logger;
    this.client = null;
    // Set by index.js in multi-bot mode. When present, pearl requests are
    // routed to whichever bot's chamber owns the target's pearl instead of
    // using the single pearlScanner/trapdoorController above.
    this.network = null;
  }

  /**
   * Connect to Discord and start listening for commands.
   * Safe to call multiple times — destroys existing client first.
   */
  async start() {
    const discordCfg = this.config.discord;

    if (!discordCfg || !discordCfg.enabled) {
      this.logger.info("Discord bot is disabled in config");
      return;
    }

    const token = process.env.DISCORD_TOKEN || discordCfg.token;
    if (!token || token === "DISCORD_BOT_TOKEN_HERE") {
      this.logger.warn("Discord token not configured — bot disabled");
      return;
    }

    // Destroy any leftover client from a previous start()
    if (this.client) {
      await this.stop();
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this._attachHandlers();

    try {
      await this.client.login(token);
    } catch (err) {
      this.logger.error(`Failed to connect to Discord: ${err.message}`);
      this.client = null;
      throw err;
    }
  }

  /**
   * Disconnect from Discord and clean up.
   */
  async stop() {
    if (!this.client) return;
    try {
      this.client.destroy();
    } catch (err) {
      this.logger.error(`Error during Discord disconnect: ${err.message}`);
    }
    this.client = null;
    this.logger.info("Discord bot disconnected");
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Check if a Discord name is authorized to use the bot.
   * Uses config.discord.whitelist if configured (Discord usernames/nicknames),
   * otherwise falls back to the Minecraft whitelist — in that case Discord
   * server nicknames must match Minecraft usernames exactly.
   */
  _isDiscordAuthorized(discordName) {
    const discordWhitelist = this.config.discord?.whitelist;
    if (Array.isArray(discordWhitelist) && discordWhitelist.length > 0) {
      return discordWhitelist.some(
        (n) => n.toLowerCase() === discordName.toLowerCase(),
      );
    }
    return this.whitelist.isAuthorized(discordName);
  }

  /** Wire up all client event handlers */
  _attachHandlers() {
    const c = this.client;

    c.on("ready", () => {
      this.logger.info(
        `Discord bot logged in as ${c.user?.tag ?? "unknown"}`,
      );
    });

    c.on("messageCreate", (msg) => this._onMessage(msg));

    c.on("error", (err) => {
      this.logger.error(`Discord client error: ${err.message}`);
    });

    // discord.js auto-reconnects; we just log the lifecycle
    c.on("shardDisconnect", (event, shardId) => {
      this.logger.warn(
        `Discord shard ${shardId} disconnected (code: ${event.code}), reconnecting...`,
      );
    });

    c.on("resume", (replayed) => {
      this.logger.info(`Discord session resumed (${replayed} events replayed)`);
    });
  }

  /**
   * Handle an incoming message.
   * Only processes messages from the configured channel.
   */
  async _onMessage(message) {
    // Never respond to bots
    if (message.author.bot) return;

    // Only respond in the configured channel
    if (!this.config.discord.channel_id) return;
    if (message.channel.id !== this.config.discord.channel_id) return;

    // Check prefix
    const prefix = this.config.discord.prefix || "!pearl";
    if (!message.content.startsWith(prefix)) return;

    // Parse target
    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const targetPlayer = args[0];

    if (!targetPlayer || !/^[a-zA-Z0-9_]{1,16}$/.test(targetPlayer)) {
      await this._sendUsage(message, prefix);
      return;
    }

    // Whitelist check: use server nickname if available, otherwise global username
    const discordName = message.member?.nickname || message.author.username;
    if (!this._isDiscordAuthorized(discordName)) {
      this.logger.warn(
        `Unauthorized pearl request by "${discordName}" (id: ${message.author.id}) for "${targetPlayer}"`,
      );
      await this._sendDenied(message);
      return;
    }

    this.logger.info(
      `Pearl request: "${discordName}" → "${targetPlayer}"`,
    );

    await this._processPearlRequest(message, targetPlayer, discordName);
  }

  /**
   * Find the pearl for the target and trigger the trapdoor.
   */
  async _processPearlRequest(message, targetPlayer, requesterName) {
    try {
      // Resolve the pearl and the controller that owns it. In multi-bot mode
      // the network points us at the right chamber; otherwise fall back to the
      // single injected scanner/controller.
      // `loader` exposes loadPearl(name, block). In multi-bot mode it's the
      // owning PearlBot (which pathfinds to the trapdoor and returns to center);
      // in standalone mode it's the raw trapdoor controller.
      let pearlData;
      let loader;
      if (this.network) {
        const owner = this.network.findOwner(targetPlayer);
        pearlData = owner?.pearl ?? null;
        loader = owner?.bot ?? null;
      } else {
        pearlData = this.pearlScanner.getPearlForPlayer(targetPlayer);
        loader = this.trapdoorController;
      }

      if (!pearlData || !loader) {
        this.logger.info(
          `No pearl found for "${targetPlayer}" (requested by "${requesterName}")`,
        );
        await this._sendNoPearl(message, targetPlayer);
        return;
      }

      await loader.loadPearl(targetPlayer, pearlData.trapdoorBlock);

      await this._sendSuccess(message, targetPlayer, requesterName, pearlData);
      this.logger.info(
        `Pearl loaded for "${targetPlayer}" (requested by "${requesterName}")`,
      );
    } catch (err) {
      this.logger.error(
        `Pearl request failed for "${targetPlayer}": ${err.message}`,
      );
      await this._sendError(message, targetPlayer, err);
    }
  }

  // ------------------------------------------------------------------
  // Embed builders
  // ------------------------------------------------------------------

  /** Send usage instructions */
  async _sendUsage(message, prefix) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle("Pearl Bot — Usage")
      .setDescription(
        `\`${prefix} <MinecraftUsername>\`\n\n` +
          "Request a stasis pearl load for the specified player. " +
          "The bot will find their pearl in the chamber and trigger the trapdoor mechanism.",
      );
    await message.channel.send({ embeds: [embed] });
  }

  /** Send access-denied embed */
  async _sendDenied(message) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.DENIED)
      .setTitle("Access Denied")
      .setDescription(
        "You are not whitelisted to use this bot.\n" +
          "Contact an administrator to be added to the whitelist.",
      );
    await message.channel.send({ embeds: [embed] });
  }

  /** Send no-pearl-found embed */
  async _sendNoPearl(message, targetPlayer) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.ERROR)
      .setTitle("Pearl Not Found")
      .setDescription(
        `No stasis pearl was found for **${targetPlayer}**.\n` +
          "They may not have a pearl stored in the chamber.",
      );
    await message.channel.send({ embeds: [embed] });
  }

  /** Send success embed */
  async _sendSuccess(message, targetPlayer, requesterName, pearlData) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle("✅ Pearl Loaded")
      .setDescription(`**${targetPlayer}** has been successfully loaded!`);

    if (pearlData.blockPos) {
      embed.addFields({
        name: "Location",
        value: `\`${pearlData.blockPos.x}, ${pearlData.blockPos.y}, ${pearlData.blockPos.z}\``,
        inline: true,
      });
    }

    embed.setFooter({ text: `Requested by ${requesterName}` });
    embed.setTimestamp();

    await message.channel.send({ embeds: [embed] });
  }

  /** Send error embed */
  async _sendError(message, targetPlayer, error) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.ERROR)
      .setTitle("Error")
      .setDescription(
        `Failed to load **${targetPlayer}**.\n\`${error.message}\``,
      );
    await message.channel.send({ embeds: [embed] });
  }

  // ------------------------------------------------------------------
  // Public channel send helper
  // ------------------------------------------------------------------

  /**
   * Send an intruder alert embed to the configured Discord channel.
   * @param {string} playerName - The intruding player's username
   */
  async sendIntruderAlert(playerName) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.ALERT)
      .setTitle('Intruder Alert')
      .setDescription(`**${playerName}** entered render distance of the stasis chamber.`)
      .addFields({ name: 'Action', value: 'Bot is disconnecting to protect the chamber.' })
      .setTimestamp();
    await this.sendToChannel({ embeds: [embed] });
  }

  /**
   * Send a plain message or embed to the configured Discord channel.
   * Useful for broadcasting status updates from other modules.
   *
   * @param {string | object} content  A string or a discord.js message payload
   *                                    (e.g. { embeds: [...], content: "..." }).
   */
  async sendToChannel(content) {
    if (!this.client) {
      this.logger.warn("sendToChannel called but Discord client is not connected");
      return;
    }
    try {
      const channel = await this.client.channels.fetch(
        this.config.discord.channel_id,
      );
      if (!channel) {
        this.logger.warn(`Discord channel ${this.config.discord.channel_id} not found`);
        return;
      }
      await channel.send(content);
    } catch (err) {
      this.logger.error(`Failed to send to Discord channel: ${err.message}`);
    }
  }
}

module.exports = DiscordBot;
