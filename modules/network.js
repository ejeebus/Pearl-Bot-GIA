/**
 * BotNetwork - Coordinates multiple PearlBot instances running in one process.
 *
 * Each bot watches its own stasis chamber. The network routes pearl requests
 * to whichever bot actually owns the target player's pearl, so in-game and
 * Discord commands work no matter which chamber the pearl lives in.
 *
 * The first registered bot is the "primary" — it's the single responder for
 * network-wide replies (e.g. "no pearl found", aggregated `!pearls` lists) so
 * that multiple bots don't all answer the same command at once.
 */
class BotNetwork {
  constructor() {
    /** @type {import('./pearl-bot')[]} */
    this.bots = [];
  }

  /** Register a PearlBot with the network. Order matters — index 0 is primary. */
  register(bot) {
    this.bots.push(bot);
  }

  /** The primary bot, or null if none registered. */
  get primary() {
    return this.bots[0] || null;
  }

  /** True if the given bot is the primary responder. */
  isPrimary(bot) {
    return this.primary === bot;
  }

  /**
   * Find the bot whose chamber currently holds the given player's pearl.
   * @param {string} playerName
   * @returns {{ bot: import('./pearl-bot'), pearl: object } | null}
   */
  findOwner(playerName) {
    for (const bot of this.bots) {
      const pearl = bot.getPearlForPlayer(playerName);
      if (pearl) return { bot, pearl };
    }
    return null;
  }

  /**
   * Aggregate every tracked pearl across all chambers.
   * @returns {Array<{ name: string, bot: string }>}
   */
  allKnownPearls() {
    const out = [];
    for (const bot of this.bots) {
      for (const name of bot.getKnownPearlNames()) {
        out.push({ name, bot: bot.name });
      }
    }
    return out;
  }
}

module.exports = BotNetwork;
