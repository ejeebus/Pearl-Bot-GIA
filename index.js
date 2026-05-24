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

  // Re-establish the chat signing session on every subsequent Play Login packet.
  // On 2b2t, Velocity transitions the client from the queue server to the game server
  // by re-entering configuration state then sending a second Play Login (0x2c).
  // minecraft-protocol's play.js already handles the FIRST login via once('login');
  // we skip that one and only re-initialize for every server after that.
  // We also reset _lastSeenMessages so queue-server message signatures don't pollute
  // the acknowledgement bitset sent to the game server, which would cause the game
  // server to reject our signed chat_message packets.
  let _firstLoginSeen = false;
  bot._client.on('login', (packet) => {
    if (packet.enforcesSecureChat !== undefined) {
      logger.info(`Server login — enforcesSecureChat: ${packet.enforcesSecureChat}`);
    }

    if (!_firstLoginSeen) {
      _firstLoginSeen = true;
      logger.info('First login (queue server) — chat session handled by protocol layer');
      return;
    }

    // Game server login after proxy transition
    const client = bot._client;
    if (!client.profileKeys) {
      logger.warn('Game server login: profileKeys not set — chat will be unsigned');
      return;
    }

    const newUUID = crypto.randomUUID().replace(/-/g, '');
    client._session = { index: 0, uuid: newUUID };

    // Clear any queue-server message acknowledgements from the seen-messages buffer.
    // If these stale signatures are included in the chat_message signing payload the
    // game server cannot verify them and silently drops the message.
    if (client._lastSeenMessages) {
      client._lastSeenMessages.length = 0;
      client._lastSeenMessages.offset = 0;
      client._lastSeenMessages.pending = 0;
    }
    client._lastChatSignature = null;

    try {
      client.write('chat_session_update', {
        sessionUUID: newUUID,
        expireTime: BigInt(client.profileKeys.expiresOn.getTime()),
        publicKey: client.profileKeys.public.export({ type: 'spki', format: 'der' }),
        signature: client.profileKeys.signatureV2,
      });
      logger.info('Chat session re-established for game server');
    } catch (err) {
      logger.warn(`Chat session update failed: ${err.message}`);
    }
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
