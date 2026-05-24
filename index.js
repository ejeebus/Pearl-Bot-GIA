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

  // Handle the proxy transition from queue server to game server.
  // Velocity sends a second Play Login (0x2c) when switching backends.
  // minecraft-protocol's once('login') in play.js handles the first one.
  //
  // Strategy: keep the session UUID that play.js established (Velocity already
  // told the game server about that UUID via player_info). Only reset the index
  // and clear the seen-messages buffer so queue-server acknowledgements don't
  // corrupt the signing payload. No new chat_session_update is needed because
  // Velocity propagated the session to the backend automatically.
  let _firstLoginSeen = false;
  bot._client.on('login', (packet) => {
    logger.info(`Server login — enforcesSecureChat: ${packet.enforcesSecureChat}`);

    if (!_firstLoginSeen) {
      _firstLoginSeen = true;
      logger.info('First login (queue server) — session initialised by protocol layer');
      return;
    }

    // Game server login after proxy transition
    const client = bot._client;
    const sessionUUID = client._session?.uuid ?? '(none)';
    const sessionIndex = client._session?.index ?? '(none)';
    logger.info(`Game server login — existing session: uuid=${sessionUUID} index=${sessionIndex}`);

    // Reset the message index so the game server (which has never seen messages
    // from this session) accepts index 0 as the first valid message.
    if (client._session) {
      client._session.index = 0;
    }

    // Clear queue-server player_chat signatures from the seen-messages buffer.
    if (client._lastSeenMessages) {
      client._lastSeenMessages.length = 0;
      client._lastSeenMessages.offset = 0;
      client._lastSeenMessages.pending = 0;
    }
    client._lastChatSignature = null;

    logger.info(`Game server login — session ready: uuid=${client._session?.uuid ?? '(none)'} index=0 profileKeys=${!!client.profileKeys}`);
  });

  // Intercept outgoing chat_message packets for diagnostics.
  // Remove this block once chat is confirmed working.
  const _origWrite = bot._client.write.bind(bot._client);
  bot._client.write = function (name, params) {
    if (name === 'chat_message') {
      logger.info(
        `[CHAT-TX] msg="${params.message}" sig=${params.signature ? params.signature.length + 'B' : 'none'} ` +
        `offset=${params.offset} ack=${params.acknowledged?.toString('hex') ?? 'none'} ` +
        `session=${bot._client._session ? bot._client._session.uuid.slice(0, 8) + '…idx' + (bot._client._session.index - 1) : 'null'}`
      );
    }
    return _origWrite(name, params);
  };

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

  bot.on('messagestr', (msg) => {
    if (msg.length < 200) {
      logger.chat(msg);
    }
  });

  bot.on('playerTeleport', (player) => {
    logger.info(`Player ${player.username} teleported`);
  });
}

function bindModules(bot) {
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
