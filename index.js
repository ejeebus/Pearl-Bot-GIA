require('dotenv').config();

const mineflayer = require('mineflayer');
const WhitelistManager = require('./modules/whitelist');
const PearlScanner = require('./modules/pearl-scanner');
const TrapdoorController = require('./modules/trapdoor');
const CommandHandler = require('./modules/commands');
const DiscordBot = require('./modules/discord');
const AntiAFK = require('./modules/anti-afk');
const QueueHandler = require('./modules/queue');
const Logger = require('./modules/logger');

const config = require('./config.json');
const logger = new Logger(config);
const whitelist = new WhitelistManager(config);

let pearlScanner, trapdoorController, commandHandler, antiAfk, queueHandler;
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

  if (authType === 'microsoft') {
    if (process.env.MICROSOFT_EMAIL && process.env.MICROSOFT_PASSWORD) {
      opts.username = process.env.MICROSOFT_EMAIL;
      opts.password = process.env.MICROSOFT_PASSWORD;
    }
  }

  if (authType === 'mojang') {
    if (process.env.MOJANG_PASSWORD) {
      opts.password = process.env.MOJANG_PASSWORD;
    }
  }

  const bot = mineflayer.createBot(opts);

  bot.once('spawn', () => {
    logger.info(`Spawned at ${bot.entity.position.floored()}`);
    onBotReady(bot);
  });

  bot.on('error', (err) => {
    logger.error(`Bot error: ${err.message}`);
  });

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

  pearlScanner = new PearlScanner(bot, config);
  trapdoorController = new TrapdoorController(bot);
  commandHandler = new CommandHandler(bot, whitelist, pearlScanner, trapdoorController, logger);
  antiAfk = new AntiAFK(bot, config.anti_afk, logger);

  discordBot.pearlScanner = pearlScanner;
  discordBot.trapdoorController = trapdoorController;

  pearlScanner.startScanning();
  commandHandler.start();
  antiAfk.start();

  setupQueueHandler(bot);
}

function setupQueueHandler(bot) {
  queueHandler = new QueueHandler(bot, config, createBot, logger);

  queueHandler.on('reconnecting', ({ attempt, delay }) => {
    logger.info(`Reconnecting (attempt ${attempt}, delay ${Math.round(delay / 1000)}s)...`);
  });

  queueHandler.on('reconnected', (newBot) => {
    logger.info('Reconnected — rebinding modules to new bot instance');
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
  if (discordBot) discordBot.stop().catch(() => {});
  if (currentBot && !shutdownRequested) {
    try { currentBot.quit('Graceful shutdown'); } catch {}
  }
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
