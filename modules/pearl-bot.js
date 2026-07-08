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
const QueueMonitor = require('./queue-monitor');
const Aura = require('./aura');
const Navigator = require('./navigator');
const { pathfinder } = require('mineflayer-pathfinder');

function formatErr(err) {
  if (!err) return 'unknown';
  if (err.errors?.length) return err.errors.map((e) => e.message || String(e)).join(', ');
  return err.message || String(err);
}

class PearlBot {
  /**
   * @param {object} botConfig - Effective single-bot config: { bot, stasis, anti_afk, queue, intruder, recruiter, aura, logging, discord, whitelist }
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

    // Logger that prefixes every line with this bot's name, so two bots'
    // aura/queue-monitor output stays distinguishable in the shared log.
    this._taggedLogger = this._makeTaggedLogger();

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
    this.aura = null;
    this.navigator = null;

    // Serializes pearl loads so concurrent chat/Discord requests don't fight
    // the pathfinder (a second goto mid-path rejects the first with GoalChanged).
    this._loadQueue = Promise.resolve();

    // Queue monitor is per-connection (attached in createBot, before spawn)
    // but the instance is long-lived — each bot has its own queue.
    this.queueMonitor = new QueueMonitor(this.config, this._taggedLogger);

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

  // A thin logger proxy that tags every message with this bot's name. Passed to
  // modules (aura, queue-monitor) that log on their own but don't tag by bot.
  _makeTaggedLogger() {
    const base = this.logger;
    const tag = (m) => this._tag(m);
    return {
      debug: (m) => base.debug(tag(m)),
      info: (m) => base.info(tag(m)),
      warn: (m) => base.warn(tag(m)),
      error: (m) => base.error(tag(m)),
      chat: (m) => base.chat(tag(m)),
    };
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

  /**
   * Load a player's pearl: walk within reach of the trapdoor, face it, toggle
   * it, then return to the chamber center. Called by both the in-game command
   * handler and the Discord bot (via BotNetwork routing). Loads are serialized
   * per-bot so simultaneous requests don't collide in the pathfinder.
   *
   * @param {string} playerName
   * @param {import('prismarine-block').Block} trapdoorBlock
   * @returns {Promise<boolean>} whether the trapdoor toggle succeeded
   */
  loadPearl(playerName, trapdoorBlock) {
    const run = this._loadQueue.then(
      () => this._runLoad(playerName, trapdoorBlock),
      () => this._runLoad(playerName, trapdoorBlock),
    );
    // Keep the chain alive regardless of this run's outcome; the caller still
    // receives the real result/error through `run`.
    this._loadQueue = run.catch(() => {});
    return run;
  }

  async _runLoad(playerName, trapdoorBlock) {
    const nav = this.navigator;
    const afk = this.antiAfk;
    const reach = this.config.stasis?.reach_range ?? 3;
    let success = false;

    // Suspend anti-AFK so its sneak/jump/look don't fight the pathfinder.
    try { afk?.stop(); } catch { /* noop */ }
    try {
      if (nav) {
        // Pathfinder only moves the bot while physics is enabled; 2b2t's config
        // state can leave it off, so force it on before walking.
        try { this.bot.physicsEnabled = true; } catch { /* noop */ }
        try {
          await nav.goNear(trapdoorBlock.position, reach);
        } catch (err) {
          // Navigation failed (no path / timeout) — still attempt the toggle from
          // wherever the bot is (works if already in reach), so a pathing issue
          // degrades gracefully instead of doing nothing.
          this.logger.warn(this._tag(`navigation failed: ${err.message} — toggling from current position`));
        }
        // activateBlock doesn't auto-look; face the trapdoor so 2b2t accepts
        // the interaction as in-reach and correctly aimed.
        await this.bot.lookAt(trapdoorBlock.position.offset(0.5, 0.5, 0.5), true);
      }
      success = await this.trapdoorController.loadPearl(playerName, trapdoorBlock);
    } finally {
      if (nav) {
        try { await nav.returnToCenter(); }
        catch (err) { this.logger.warn(this._tag(`returnToCenter failed: ${err.message}`)); }
      }
      try { afk?.start(); } catch { /* noop */ }
    }
    return success;
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
    if (this.aura) this.aura.stop();
    if (this.queueMonitor) this.queueMonitor.stop();
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
    // Pathfinding plugin — reinstalled on every reconnect (each is a fresh bot).
    bot.loadPlugin(pathfinder);
    let hasSpawned = false;

    // Attach the queue monitor before any spawn handler so it sees the whole
    // queue via playerlist_header (which fires pre-spawn).
    this.queueMonitor.attach(bot);

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
      this.queueMonitor.onSpawn(); // queue finished — stop the counter, log completion
      this.logger.info(this._tag(`${isFirst ? 'Spawned' : 'Re-spawned'} at ${bot.entity.position.floored()}`));
      this.onBotReady(bot);
    });

    bot.on('error', (err) => this.logger.error(this._tag(`Bot error: ${formatErr(err)}`)));

    // Rubber-band detector: the server teleporting the bot back means it
    // rejected the bot's movement (bot frozen server-side). If these fire after
    // a pearl request, 2b2t is refusing our walk — the desync we're chasing.
    bot.on('forcedMove', () => {
      if (hasSpawned) this.logger.warn(this._tag(`Server repositioned bot to ${bot.entity.position.floored()} (movement rejected / rubber-band)`));
    });

    // If disconnected before spawn (e.g. kicked while queued), reconnect
    // manually since QueueHandler only attaches after spawn. Guard because
    // both 'kicked' and 'end' can fire for the same disconnect.
    let reconnectScheduled = false;
    const onPreSpawnDisconnect = (reason) => {
      if (hasSpawned || this.shutdownRequested || reconnectScheduled) return;
      reconnectScheduled = true;
      this.queueMonitor.detach(); // stop tracking this dead connection's queue
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
    // NOTE: the old "login-mute walk" (a blind forward walk right after spawn)
    // was removed — this bot's chat is disabled anyway, and moving before the
    // server has fully accepted the spawn position is a likely trigger for the
    // client/server position desync that freezes the bot server-side.
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
    if (this.aura) this.aura.stop();

    this.pearlScanner = new PearlScanner(bot, this.config, this.logger);
    this.trapdoorController = new TrapdoorController(bot, this.logger);
    this.navigator = new Navigator(bot, this.config, this._taggedLogger);
    this.recruiter = new Recruiter(bot, this.config, this.logger);
    this.commandHandler = new CommandHandler(
      bot, this.whitelist, this.pearlScanner, this.trapdoorController, this.recruiter, this.logger,
      { network: this.network, pearlBot: this }
    );
    this.antiAfk = new AntiAFK(bot, this.config, this.logger);
    this.intruderDetector = new IntruderDetector(bot, this.whitelist, this.logger);
    this.aura = new Aura(bot, this.config, this._taggedLogger);

    this.pearlScanner.startScanning();
    this.commandHandler.start();
    this.antiAfk.start();
    this.aura.start(); // Aura.start() self-guards on config.aura.enabled
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
