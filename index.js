require('dotenv').config();

const crypto = require('crypto');
const mineflayer = require('mineflayer');
const WhitelistManager = require('./modules/whitelist');
const PearlScanner = require('./modules/pearl-scanner');
const TrapdoorController = require('./modules/trapdoor');
const CommandHandler = require('./modules/commands');
const DiscordBot = require('./modules/discord');
const AntiAFK = require('./modules/anti-afk');
const QueueHandler = require('./modules/queue');
const IntruderDetector = require('./modules/intruder');
const Recruiter = require('./modules/recruiter');
const Logger = require('./modules/logger');

let config;
try {
  config = require('./config.json');
} catch {
  console.error('[FATAL] config.json not found — copy config.example.json to config.json and fill in your settings.');
  process.exit(1);
}
const logger = new Logger(config);
const whitelist = new WhitelistManager(config);

let pearlScanner, trapdoorController, commandHandler, antiAfk, queueHandler, intruderDetector, recruiter;
let currentBot = null;
let shutdownRequested = false;

const discordBot = new DiscordBot(config, whitelist, null, null, logger);

function createBot() {
  const authType = config.bot.auth || 'microsoft';

  const opts = {
    host: config.bot.host,
    port: config.bot.port,
    username: config.bot.username,
    auth: authType,
    version: config.bot.version,
    // 2b2t reports enforcesSecureChat: false, so unsigned messages are accepted.
    // Disabling chat signing skips fetching Mojang profile key certificates,
    // which means client.profileKeys stays null and _signedChat sends chat_message
    // packets without a signature — no signature chain for the proxy to break.
    disableChatSigning: true,
  };

  if (authType === 'mojang') {
    if (process.env.MOJANG_PASSWORD) {
      opts.password = process.env.MOJANG_PASSWORD;
    }
  }

  const bot = mineflayer.createBot(opts);
  let hasSpawned = false;

  bot._client.on('error', (err) => logger.error(`[CLIENT ERR] ${err.message}`));

  // Pause physics during configuration state so we don't send position packets
  // to the server while it's not in play state — 2b2t re-enters config after queue
  // and Velocity crashes if it receives unexpected position packets during that phase.
  bot._client.on('state', (newState) => {
    if (newState === 'configuration') bot.physicsEnabled = false;
    else if (newState === 'play') bot.physicsEnabled = true;
  });

  // Log enforcesSecureChat from each login packet for observability.
  bot._client.on('login', (packet) => {
    logger.info(`Server login — enforcesSecureChat: ${packet.enforcesSecureChat}`);
  });

  bot.once('spawn', () => {
    hasSpawned = true;
    bot.physicsEnabled = true;
    logger.info(`Spawned at ${bot.entity.position.floored()}`);
    onBotReady(bot);
  });

  bot.on('error', (err) => {
    logger.error(`Bot error: ${err.message}`);
  });

  // If disconnected before spawn (e.g. kicked while in 2b2t queue), reconnect manually
  // since QueueHandler only attaches after spawn. Guard with a flag because both
  // 'kicked' and 'end' can fire for the same disconnect.
  let reconnectScheduled = false;
  const onPreSpawnDisconnect = (reason) => {
    if (hasSpawned || shutdownRequested || reconnectScheduled) return;
    reconnectScheduled = true;
    const reasonStr = typeof reason === 'string' ? reason : (reason ? JSON.stringify(reason) : 'unknown');
    logger.warn(`Disconnected before spawn: ${reasonStr} — reconnecting in 30s`);
    setTimeout(() => { if (!shutdownRequested) createBot(); }, 30000);
  };

  bot.once('end', onPreSpawnDisconnect);
  bot.once('kicked', onPreSpawnDisconnect);

  return bot;
}

function onBotReady(bot) {
  currentBot = bot;

  bindModules(bot);

  // Walk briefly after spawning to clear 2b2t's per-session login mute.
  // 2b2t soft-mutes every client on login until position-change packets arrive;
  // without this the bot can receive chat but all outgoing chat_message packets
  // are silently dropped regardless of signing state.
  setTimeout(() => {
    try {
      logger.info('Login-mute walk: moving forward briefly');
      bot.setControlState('forward', true);
      setTimeout(() => {
        try { bot.setControlState('forward', false); } catch {}
        logger.info('Login-mute walk: complete');
      }, 1500);
    } catch (err) {
      logger.warn(`Login-mute walk failed: ${err.message}`);
    }
  }, 4000);

  bot.on('messagestr', (msg) => {
    if (msg.length < 200) {
      logger.chat(msg);
    }
  });

  bot.on('playerTeleport', (player) => {
    logger.info(`Player ${player.username} teleported`);
  });
}

function installWriteInterceptor(bot) {
  // Patch bot._client.write with .call() so 'this' is always the client instance,
  // avoiding binding issues. Re-called each time bindModules runs so the interceptor
  // survives reconnects (new bot instances).
  const client = bot._client;
  if (client._writePatched) return; // already patched for this client
  client._writePatched = true;
  const origWrite = client.write;
  client.write = function patchedWrite(name, params) {
    if (name === 'chat_message' || name === 'chat_command' || name === 'chat_command_signed') {
      logger.info(`[PKT-OUT] ${name} serializer.writable=${this.serializer?.writable} msg=${JSON.stringify(params?.message ?? params?.command)} sig=${params?.signature ? 'YES' : 'NO'}`);
    }
    return origWrite.call(this, name, params);
  };
}

function bindModules(bot) {
  installWriteInterceptor(bot);

  if (pearlScanner) pearlScanner.stopScanning();
  if (commandHandler) commandHandler.stop();
  if (antiAfk) antiAfk.stop();
  if (queueHandler) queueHandler.stop();
  if (intruderDetector) intruderDetector.stop();
  if (recruiter) recruiter.stop();

  pearlScanner = new PearlScanner(bot, config, logger);
  trapdoorController = new TrapdoorController(bot, logger);
  recruiter = new Recruiter(bot, config, logger);
  commandHandler = new CommandHandler(bot, whitelist, pearlScanner, trapdoorController, recruiter, logger);
  antiAfk = new AntiAFK(bot, config.anti_afk, logger);
  intruderDetector = new IntruderDetector(bot, whitelist, logger);

  discordBot.pearlScanner = pearlScanner;
  discordBot.trapdoorController = trapdoorController;

  pearlScanner.startScanning();
  commandHandler.start();
  antiAfk.start();
  recruiter.start();

  if (config.intruder?.enabled !== false) {
    intruderDetector.start();
    intruderDetector.on('intruder', (playerName) => {
      discordBot.sendIntruderAlert(playerName).catch(() => {});

      if (config.intruder?.auto_disconnect) {
        const delay = config.intruder.reconnect_delay_ms ?? 300000;
        logger.warn(`Intruder ${playerName} — disconnecting, reconnecting in ${Math.round(delay / 1000)}s`);
        intruderDetector.stop();
        if (queueHandler) queueHandler.stop();
        try { bot.quit('Intruder detected'); } catch (err) {
          logger.debug(`bot.quit failed during intruder disconnect: ${err.message}`);
        }
        setTimeout(() => { if (!shutdownRequested) createBot(); }, delay);
      }
    });
  }

  setupQueueHandler(bot);
}

function setupQueueHandler(bot) {
  queueHandler = new QueueHandler(bot, config, createBot, logger);

  queueHandler.on('reconnecting', ({ attempt, delay }) => {
    logger.info(`Reconnecting (attempt ${attempt}, delay ${Math.round(delay / 1000)}s)...`);
  });

  queueHandler.on('reconnected', (newBot) => {
    logger.info('Reconnected — rebinding modules to new bot instance');
    currentBot = newBot;
    bindModules(newBot);
  });

  queueHandler.on('max-attempts-reached', () => {
    logger.error('Max reconnect attempts exhausted — shutting down');
    cleanup();
    process.exit(1);
  });

  queueHandler.start();
}

function cleanup() {
  if (pearlScanner) pearlScanner.stopScanning();
  if (commandHandler) commandHandler.stop();
  if (antiAfk) antiAfk.stop();
  if (queueHandler) queueHandler.stop();
  if (intruderDetector) intruderDetector.stop();
  if (recruiter) recruiter.stop();
  if (discordBot) discordBot.stop().catch(() => {});
  if (currentBot && !shutdownRequested) {
    try { currentBot.quit('Graceful shutdown'); } catch {}
  }
  logger.close();
}

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down');
  shutdownRequested = true;
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  shutdownRequested = true;
  cleanup();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason?.message || reason}`);
});

logger.info(`Starting pearl bot — connecting to ${config.bot.host}:${config.bot.port}`);
createBot();

discordBot.start().catch((err) => {
  logger.warn(`Discord bot startup failed: ${err.message}`);
});
