/**
 * PearlBot - Encapsulates a single Mineflayer bot and all of its per-bot
 * modules (pearl scanner, trapdoor controller, command handler, anti-AFK,
 * queue/reconnect, intruder detector, recruiter).
 *
 * Multiple PearlBot instances run in one process, each watching its own
 * stasis chamber. Shared services (logger, whitelist, Discord bot, chat
 * logger, and the BotNetwork coordinator) are injected via the `shared`
 * object so every bot reports through the same Discord channel and writes
 * to the same chat-log database.
 *
 * The SQLite/Discord/whitelist lifecycles live outside this class; a PearlBot
 * only owns its own Minecraft connection and rebinds its modules on every
 * (re)spawn, exactly like the original single-bot index.js did.
 */

const mineflayer = require('mineflayer');
const PearlScanner = require('./pearl-scanner');
const TrapdoorController = require('./trapdoor');
const CommandHandler = require('./commands');
const AntiAFK = require('./anti-afk');
const QueueHandler = require('./queue');
const IntruderDetector = require('./intruder');
const Recruiter = require('./recruiter');

function formatErr(err) {
  if (!err) return 'unknown';
  if (err.errors?.length) return err.errors.map((e) => e.message || String(e)).join(', ');
  return err.message || String(err);
}

class PearlBot {
  /**
   * @param {object} botConfig - Effective single-bot config: { bot, stasis, anti_afk, queue, intruder, recruiter, logging, discord, whitelist }
   * @param {object} shared - { logger, whitelist, discordBot, chatLogger, network }
   */
  constructor(botConfig, shared) {
    this.config = botConfig;
    this.name = botConfig.bot.name || botConfig.bot.username || 'bot';

    this.logger = shared.logger;
    this.whitelist = shared.whitelist;
    this.discordBot = shared.discordBot;
    this.chatLogger = shared.chatLogger;
    this.network = shared.network;

    this.bot = null;
    this._prevBot = null;
    this.shutdownRequested = false;

    // Per-bot module instances — recreated on every rebind.
    this.pearlScanner = null;
    this.trapdoorController = null;
    this.commandHandler = null;
    this.antiAfk = null;
    this.queueHandler = null;
    this.intruderDetector = null;
    this.recruiter = null;

    this._chatListenerBot = null;
    this._chatListener = (msg) => {
      if (msg.length < 200) this.logger.chat(`[${this.name}] ${msg}`);
    };
    this._teleportListener = (player) => {
      this.logger.info(this._tag(`Player ${player.username} teleported`));
    };
  }

  _tag(msg) {
    return `[${this.name}] ${msg}`;
  }

  // ------------------------------------------------------------------
  // Coordinator-facing accessors (used by BotNetwork / DiscordBot)
  // ------------------------------------------------------------------

  getPearlForPlayer(playerName) {
    return this.pearlScanner ? this.pearlScanner.getPearlForPlayer(playerName) : null;
  }

  getKnownPearlNames() {
    return this.pearlScanner ? [...this.pearlScanner.getKnownPearls().keys()] : [];
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  start() {
    this.logger.info(
      this._tag(`Starting — connecting to ${this.config.bot.host}:${this.config.bot.port} as ${this.config.bot.username}`)
    );
    this.createBot();
  }

  stop() {
    this.shutdownRequested = true;
    if (this.pearlScanner) this.pearlScanner.stopScanning();
    if (this.commandHandler) this.commandHandler.stop();
    if (this.antiAfk) this.antiAfk.stop();
    if (this.queueHandler) this.queueHandler.stop();
    if (this.intruderDetector) this.intruderDetector.stop();
    if (this.recruiter) this.recruiter.stop();
    if (this.bot) {
      try { this.bot.quit('Graceful shutdown'); } catch { /* already gone */ }
    }
  }

  createBot() {
    const authType = this.config.bot.auth || 'microsoft';

    const opts = {
      host: this.config.bot.host,
      port: this.config.bot.port,
      username: this.config.bot.username,
      auth: authType,
      version: this.config.bot.version,
      // See index.js history: disabling chat signing avoids the Mojang
      // certificate fetch so Velocity forwards unsigned chat as a
      // session-less client.
      disableChatSigning: true,
    };

    if (authType === 'mojang' && process.env.MOJANG_PASSWORD) {
      opts.password = process.env.MOJANG_PASSWORD;
    }

    const bot = mineflayer.createBot(opts);
    this.bot = bot;
    let hasSpawned = false;

    bot._client.on('error', (err) => this.logger.error(this._tag(`[CLIENT ERR] ${formatErr(err)}`)));

    // Pause physics during configuration state so we don't send position
    // packets while the server isn't in play state (2b2t re-enters config
    // after the queue and Velocity dislikes unexpected position packets then).
    bot._client.on('state', (newState) => {
      if (newState === 'configuration') bot.physicsEnabled = false;
      else if (newState === 'play') bot.physicsEnabled = true;
    });

    let loginCount = 0;
    bot._client.on('login', (packet) => {
      loginCount++;
      this.logger.info(this._tag(`Server login #${loginCount} — enforcesSecureChat: ${packet.enforcesSecureChat}`));
    });

    bot.on('spawn', () => {
      const isFirst = !hasSpawned;
      hasSpawned = true;
      bot.physicsEnabled = true;
      this.logger.info(this._tag(`${isFirst ? 'Spawned' : 'Re-spawned'} at ${bot.entity.position.floored()}`));
      this.onBotReady(bot);
    });

    bot.on('error', (err) => this.logger.error(this._tag(`Bot error: ${formatErr(err)}`)));

    // If disconnected before spawn (e.g. kicked while queued), reconnect
    // manually since QueueHandler only attaches after spawn. Guard because
    // both 'kicked' and 'end' can fire for the same disconnect.
    let reconnectScheduled = false;
    const onPreSpawnDisconnect = (reason) => {
      if (hasSpawned || this.shutdownRequested || reconnectScheduled) return;
      reconnectScheduled = true;
      const reasonStr = typeof reason === 'string' ? reason : (reason ? JSON.stringify(reason) : 'unknown');
      this.logger.warn(this._tag(`Disconnected before spawn: ${reasonStr} — reconnecting in 30s`));
      setTimeout(() => { if (!this.shutdownRequested) this.createBot(); }, 30000);
    };

    bot.once('end', onPreSpawnDisconnect);
    bot.once('kicked', onPreSpawnDisconnect);

    return bot;
  }

  onBotReady(bot) {
    this.bindModules(bot);

    // Walk briefly after spawning to clear 2b2t's per-session login mute.
    setTimeout(() => {
      try {
        this.logger.info(this._tag('Login-mute walk: moving forward briefly'));
        bot.setControlState('forward', true);
        setTimeout(() => {
          try { bot.setControlState('forward', false); } catch { /* noop */ }
          this.logger.info(this._tag('Login-mute walk: complete'));
        }, 1500);
      } catch (err) {
        this.logger.warn(this._tag(`Login-mute walk failed: ${err.message}`));
      }
    }, 4000);
  }

  installWriteInterceptor(bot) {
    const client = bot._client;
    if (client._writePatched) return;
    client._writePatched = true;
    const origWrite = client.write;
    const tag = this._tag.bind(this);
    const logger = this.logger;
    client.write = function patchedWrite(name, params) {
      if (name === 'chat_message' || name === 'chat_command' || name === 'chat_command_signed') {
        logger.info(tag(`[PKT-OUT] ${name} serializer.writable=${this.serializer?.writable} msg=${JSON.stringify(params?.message ?? params?.command)} sig=${params?.signature ? 'YES' : 'NO'}`));
      } else if (name === 'chat_session_update') {
        logger.info(tag(`[PKT-OUT] chat_session_update uuid=${params?.sessionUUID}`));
      }
      return origWrite.call(this, name, params);
    };
  }

  bindModules(bot) {
    this.installWriteInterceptor(bot);

    // Move chat/teleport listeners to the new bot instance.
    if (this._chatListenerBot && this._chatListenerBot !== bot) {
      this._chatListenerBot.removeListener('messagestr', this._chatListener);
      this._chatListenerBot.removeListener('playerTeleport', this._teleportListener);
    }
    if (this._chatListenerBot !== bot) {
      bot.on('messagestr', this._chatListener);
      bot.on('playerTeleport', this._teleportListener);
      this._chatListenerBot = bot;
    }

    // Chat logger: attach to this bot instance, detaching the previous one.
    if (this._prevBot && this._prevBot !== bot) this.chatLogger.unbind(this._prevBot);
    this.chatLogger.bind(bot);
    this._prevBot = bot;

    if (this.pearlScanner) this.pearlScanner.stopScanning();
    if (this.commandHandler) this.commandHandler.stop();
    if (this.antiAfk) this.antiAfk.stop();
    if (this.queueHandler) this.queueHandler.stop();
    if (this.intruderDetector) this.intruderDetector.stop();
    if (this.recruiter) this.recruiter.stop();

    this.pearlScanner = new PearlScanner(bot, this.config, this.logger);
    this.trapdoorController = new TrapdoorController(bot, this.logger);
    this.recruiter = new Recruiter(bot, this.config, this.logger);
    this.commandHandler = new CommandHandler(
      bot, this.whitelist, this.pearlScanner, this.trapdoorController, this.recruiter, this.logger,
      { network: this.network, pearlBot: this }
    );
    this.antiAfk = new AntiAFK(bot, this.config.anti_afk, this.logger);
    this.intruderDetector = new IntruderDetector(bot, this.whitelist, this.logger);

    this.pearlScanner.startScanning();
    this.commandHandler.start();
    this.antiAfk.start();
    if (this.config.recruiter?.enabled !== false) this.recruiter.start();

    if (this.config.intruder?.enabled !== false) {
      this.intruderDetector.start();
      this.intruderDetector.on('intruder', (playerName) => {
        this.discordBot.sendIntruderAlert(playerName).catch(() => {});

        if (this.config.intruder?.auto_disconnect) {
          const delay = this.config.intruder.reconnect_delay_ms ?? 300000;
          this.logger.warn(this._tag(`Intruder ${playerName} — disconnecting, reconnecting in ${Math.round(delay / 1000)}s`));
          this.intruderDetector.stop();
          if (this.queueHandler) this.queueHandler.stop();
          try { bot.quit('Intruder detected'); } catch (err) {
            this.logger.debug(this._tag(`bot.quit failed during intruder disconnect: ${err.message}`));
          }
          setTimeout(() => { if (!this.shutdownRequested) this.createBot(); }, delay);
        }
      });
    }

    this.setupQueueHandler(bot);
  }

  setupQueueHandler(bot) {
    this.queueHandler = new QueueHandler(bot, this.config, () => this.createBot(), this.logger);

    this.queueHandler.on('reconnecting', ({ attempt, delay }) => {
      this.logger.info(this._tag(`Reconnecting (attempt ${attempt}, delay ${Math.round(delay / 1000)}s)...`));
    });

    this.queueHandler.on('reconnected', (newBot) => {
      this.logger.info(this._tag('Reconnected — rebinding modules to new bot instance'));
      this.bindModules(newBot);
    });

    this.queueHandler.on('max-attempts-reached', () => {
      this.logger.error(this._tag('Max reconnect attempts exhausted for this bot'));
    });

    this.queueHandler.start();
  }
}

module.exports = PearlBot;
