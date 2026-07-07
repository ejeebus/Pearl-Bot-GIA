/**
 * Navigator - Pathfinding movement for a single bot.
 *
 * Walks the bot to within reach of a trapdoor before it's toggled, and back to
 * the chamber center afterward. Without this, `bot.activateBlock` only works
 * when the bot happens to be within ~4.5 blocks of the trapdoor — fine for a
 * small chamber, but most trapdoors in a large chamber are out of reach and the
 * activation is silently ignored.
 *
 * Wraps mineflayer-pathfinder. Movements are locked down so the bot never
 * modifies the chamber: no digging, placing, pillaring, or parkour — and
 * critically `canOpenDoors = false` so the pathfinder never toggles the stasis
 * trapdoors it walks past (which would drop pearls prematurely).
 *
 * Config (config.stasis):
 *   reach_range   number   (default 3)  — how close to get to a trapdoor
 *   home          {x,y,z}  (default chamber_center) — where to stand after a load
 *   home_radius   number   (default 1)  — arrival tolerance when returning home
 */

const { Movements, goals } = require('mineflayer-pathfinder');

const DEFAULT_REACH_RANGE = 3;
const DEFAULT_HOME_RADIUS = 1;
// Abort a stuck walk so the per-bot load mutex can't deadlock (e.g. if the
// client transiently re-enters 'configuration' state mid-path).
const GOTO_TIMEOUT_MS = 30000;

class Navigator {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} config - per-bot config (reads config.stasis)
   * @param {object} logger
   */
  constructor(bot, config, logger) {
    this.bot = bot;
    this.config = config;
    this.logger = logger;
    this._movements = null;
  }

  /**
   * Build and install Movements once. Deferred to first use because Movements
   * reads bot.registry, which only exists after the bot has spawned.
   */
  _ensureMovements() {
    if (this._movements) return;
    const m = new Movements(this.bot);
    m.canDig = false; // never break chamber blocks
    m.allow1by1towers = false; // never pillar up
    m.allowParkour = false; // keep paths simple/safe in tight chambers
    m.scafoldingBlocks = []; // never place blocks (library's spelling)
    m.canOpenDoors = false; // never toggle trapdoors/doors it walks past
    this.bot.pathfinder.setMovements(m);
    this._movements = m;
  }

  async _goto(x, y, z, range) {
    this._ensureMovements();
    const goto = this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, range));
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('pathfinder timeout')), GOTO_TIMEOUT_MS);
    });
    try {
      await Promise.race([goto, timeout]);
    } catch (err) {
      // Stop the (possibly still-running) walk and swallow the goto's own
      // rejection so it doesn't surface as an unhandled rejection.
      try { this.bot.pathfinder.setGoal(null); } catch { /* noop */ }
      goto.catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Walk to within reach of a block position.
   * @param {{x:number,y:number,z:number}} pos - trapdoor position (Vec3 or plain)
   * @param {number} [range]
   */
  async goNear(pos, range) {
    const r = range ?? this.config.stasis?.reach_range ?? DEFAULT_REACH_RANGE;
    await this._goto(pos.x, pos.y, pos.z, r);
  }

  /** Walk back to the chamber center (or a configured `home` spot). */
  async returnToCenter() {
    const home = this.config.stasis?.home ?? this.config.stasis?.chamber_center;
    if (!home) return;
    const r = this.config.stasis?.home_radius ?? DEFAULT_HOME_RADIUS;
    await this._goto(home.x, home.y, home.z, r);
  }
}

module.exports = Navigator;
