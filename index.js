require('dotenv').config();

const Logger = require('./modules/logger');
const WhitelistManager = require('./modules/whitelist');
const DiscordBot = require('./modules/discord');
const ChatLogger = require('./modules/chat-logger');
const BotNetwork = require('./modules/network');
const PearlBot = require('./modules/pearl-bot');

let config;
try {
  config = require('./config.json');
} catch (err) {
  if (err.code === 'MODULE_NOT_FOUND') {
    console.error('[FATAL] config.json not found — copy config.example.json to config.json and fill in your settings.');
  } else {
    console.error(`[FATAL] config.json could not be loaded: ${err.message}`);
  }
  process.exit(1);
}

const logger = new Logger(config);
const whitelist = new WhitelistManager(config);

function formatErr(err) {
  if (!err) return 'unknown';
  if (err.errors?.length) return err.errors.map((e) => e.message || String(e)).join(', ');
  return err.message || String(err);
}

/**
 * Build one effective per-bot config from the shared config. Supports both the
 * multi-bot shape (`config.bots: [...]`) and the legacy single-bot shape
 * (`config.bot` + `config.stasis`), so existing config.json files keep working.
 *
 * Each bot entry may override any of anti_afk / queue / intruder / recruiter;
 * otherwise it inherits the shared top-level block.
 */
function buildBotConfigs(cfg) {
  const inherit = (entry, key) => (entry[key] !== undefined ? entry[key] : cfg[key]);

  let entries;
  if (Array.isArray(cfg.bots) && cfg.bots.length > 0) {
    entries = cfg.bots;
  } else if (cfg.bot) {
    entries = [{ ...cfg.bot, stasis: cfg.stasis }];
  } else {
    throw new Error('No bots configured — add a "bots" array (or a legacy "bot" block) to config.json');
  }

  return entries.map((entry) => ({
    bot: {
      name: entry.name,
      username: entry.username,
      auth: entry.auth,
      host: entry.host,
      port: entry.port,
      version: entry.version,
    },
    stasis: entry.stasis,
    anti_afk: inherit(entry, 'anti_afk'),
    queue: inherit(entry, 'queue'),
    intruder: inherit(entry, 'intruder'),
    recruiter: inherit(entry, 'recruiter'),
    logging: cfg.logging,
    discord: cfg.discord,
    whitelist: cfg.whitelist,
  }));
}

let botConfigs;
try {
  botConfigs = buildBotConfigs(config);
} catch (err) {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
}

// Shared services — one Discord connection and one chat-log DB for all bots.
const network = new BotNetwork();
const discordBot = new DiscordBot(config, whitelist, null, null, logger);
discordBot.network = network;
const chatLogger = new ChatLogger(config, logger, discordBot);
chatLogger.start();

const shared = { logger, whitelist, discordBot, chatLogger, network };
const pearlBots = botConfigs.map((botConfig) => {
  const pearlBot = new PearlBot(botConfig, shared);
  network.register(pearlBot);
  return pearlBot;
});

function cleanup() {
  for (const pearlBot of pearlBots) pearlBot.stop();
  if (chatLogger) chatLogger.close();
  if (discordBot) discordBot.stop().catch(() => {});
  logger.close();
}

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  cleanup();
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${formatErr(reason)}`);
});

logger.info(`Starting pearl bot network — ${pearlBots.length} bot(s): ${pearlBots.map((b) => b.name).join(', ')}`);
for (const pearlBot of pearlBots) pearlBot.start();

discordBot.start().catch((err) => {
  logger.warn(`Discord bot startup failed: ${err.message}`);
});
