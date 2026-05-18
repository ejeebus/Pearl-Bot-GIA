/**
 * PearlScanner - Scans for ender pearl entities in the stasis chamber
 * and maps them to their controlling trapdoor positions.
 *
 * Pearl ownership is resolved by reading signs placed adjacent to each
 * stasis slot. Signs must be within Manhattan distance 3 of their
 * trapdoor; the first non-empty line of the sign is treated as the
 * player name. Call scanSigns() once after the bot spawns near the
 * chamber, or whenever signs are added/changed.
 *
 * Events:
 *   'pearl-found'  ({ entity, blockPos, playerName })
 *   'pearl-lost'   (playerName)
 */

const EventEmitter = require('events');
const Vec3 = require('vec3');

// Max Manhattan distance from a sign block to its associated trapdoor.
const SIGN_TRAPDOOR_RADIUS = 3;

class PearlScanner extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {object} config
   * @param {object} config.stasis
   * @param {{x:number,y:number,z:number}} config.stasis.chamber_center
   * @param {number} config.stasis.scan_radius
   * @param {number} config.stasis.scan_interval_ms
   * @param {import('./logger')} logger
   */
  constructor(bot, config, logger) {
    super();
    this.bot = bot;
    this.config = config;
    this.logger = logger;
    this._scanTimer = null;
    /** @type {Map<string, {entity: object, blockPos: import('vec3').Vec3}>} */
    this._knownPearls = new Map();
    /** trapdoor position key → player name, built by scanSigns() */
    this._signMap = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Scan blocks in the chamber area for signs, find the nearest trapdoor to
   * each sign, and store the mapping. Call this after the bot spawns near the
   * chamber and again whenever signs are added or changed.
   *
   * @returns {number} Number of sign→trapdoor mappings found
   */
  scanSigns() {
    const { chamber_center: cc, scan_radius: r } = this.config.stasis;
    const newMap = new Map();

    for (let x = Math.floor(cc.x - r); x <= Math.ceil(cc.x + r); x++) {
      for (let y = Math.floor(cc.y - r); y <= Math.ceil(cc.y + r); y++) {
        for (let z = Math.floor(cc.z - r); z <= Math.ceil(cc.z + r); z++) {
          const block = this.bot.blockAt(new Vec3(x, y, z));
          if (!block || !block.name.includes('sign')) continue;

          const playerName = this._readSignName(block);
          if (!playerName) continue;

          const trapdoor = this._findNearestTrapdoor(new Vec3(x, y, z));
          if (!trapdoor) {
            this.logger.warn(
              `Sign for "${playerName}" at ${x},${y},${z} has no trapdoor within ${SIGN_TRAPDOOR_RADIUS} blocks`
            );
            continue;
          }

          const key = posKey(trapdoor.position);
          if (newMap.has(key)) {
            this.logger.warn(
              `Two signs map to the same trapdoor at ${key} — keeping first ("${newMap.get(key)}"), ignoring "${playerName}"`
            );
            continue;
          }

          newMap.set(key, playerName);
          this.logger.info(
            `Mapped "${playerName}" → trapdoor at ${key}`
          );
        }
      }
    }

    this._signMap = newMap;
    this.logger.info(`Sign scan complete: ${newMap.size} slot(s) mapped`);
    return newMap.size;
  }

  /**
   * Scan all loaded entities for ender pearls within the configured radius,
   * map each to its controlling trapdoor, and resolve the owning player.
   */
  scan() {
    const { chamber_center: cc, scan_radius: r } = this.config.stasis;
    const radiusSq = r ** 2;
    const pearls = [];

    for (const entity of Object.values(this.bot.entities)) {
      if (entity.name !== 'ender_pearl') continue;

      const dx = entity.position.x - cc.x;
      const dy = entity.position.y - cc.y;
      const dz = entity.position.z - cc.z;
      if (dx * dx + dy * dy + dz * dz > radiusSq) continue;

      const blockPos = entity.position.floored().offset(0, 1, 0);
      const block = this.bot.blockAt(blockPos);

      if (!block || !block.name.includes('trapdoor')) {
        this.logger.warn(
          `No trapdoor found above pearl at ${blockPos} (entity ${entity.id})`
        );
        continue;
      }

      const playerName = this._resolvePearlOwner(entity, blockPos);
      pearls.push({ entity, blockPos, playerName });
    }

    return pearls;
  }

  /**
   * Start periodic pearl scanning. Runs an immediate sign scan and pearl scan.
   */
  startScanning() {
    if (this._scanTimer) return;

    this.scanSigns();
    this._update();

    const interval = this.config.stasis.scan_interval_ms;
    this._scanTimer = setInterval(() => this._update(), interval);
    if (this._scanTimer.unref) this._scanTimer.unref();
  }

  stopScanning() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
  }

  /**
   * Get pearl info for a named player.
   * @returns {{entity, blockPos, trapdoorBlock, playerName}|null}
   */
  getPearlForPlayer(playerName) {
    const lower = playerName.toLowerCase();
    for (const [name, info] of this._knownPearls) {
      if (name.toLowerCase() === lower) {
        const trapdoorBlock = this.bot.blockAt(info.blockPos);
        return { entity: info.entity, blockPos: info.blockPos, trapdoorBlock, playerName: name };
      }
    }
    return null;
  }

  /** @returns {Map} Shallow copy of all currently tracked pearls */
  getKnownPearls() {
    return new Map(this._knownPearls);
  }

  /** @returns {Map} Shallow copy of the current sign→trapdoor map */
  getSignMap() {
    return new Map(this._signMap);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _update() {
    const current = this.scan();
    const currentKeys = new Set(current.map((p) => p.playerName));

    for (const [name] of this._knownPearls) {
      if (!currentKeys.has(name)) {
        this._knownPearls.delete(name);
        this.emit('pearl-lost', name);
      }
    }

    for (const pearl of current) {
      const prev = this._knownPearls.get(pearl.playerName);
      const isNew = !prev;
      const hasMoved = prev && !prev.entity.position.equals(pearl.entity.position);

      if (isNew || hasMoved) {
        this._knownPearls.set(pearl.playerName, pearl);
        this.emit('pearl-found', pearl);
      }
    }
  }

  /**
   * Resolve which player owns a given pearl entity.
   *
   * Resolution order:
   *   1. Sign map  — trapdoor position looked up in pre-built sign→trapdoor table
   *   2. UUID metadata  — entity metadata cross-referenced with bot.players tab-list
   *   3. Thrower entity  — metadata entity-ID reference resolved via bot.entities
   *   4. Previously known  — same entity.id seen in a prior scan
   *   5. Fallback  — __pearl_<entity_id>
   *
   * @param {object} entity
   * @param {import('vec3').Vec3} trapdoorPos
   * @returns {string}
   */
  _resolvePearlOwner(entity, trapdoorPos) {
    // Strategy 1: sign map
    if (trapdoorPos) {
      const name = this._signMap.get(posKey(trapdoorPos));
      if (name) return name;
    }

    // Strategy 2 & 3: entity metadata
    try {
      const meta = entity.metadata;
      if (meta) {
        for (const val of Object.values(meta)) {
          if (typeof val === 'string' && val.length === 36 && val.includes('-')) {
            const cleaned = val.replace(/-/g, '').toLowerCase();
            if (/^[0-9a-f]{32}$/.test(cleaned)) {
              const found = this._findPlayerByUUID(cleaned);
              if (found) return found;
            }
          }
          if (Array.isArray(val) && val.length === 4 && val.every((n) => typeof n === 'number')) {
            const hex = val.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
            const found = this._findPlayerByUUID(hex);
            if (found) return found;
          }
        }

        const throwerId = meta[8] ?? meta[7];
        if (typeof throwerId === 'number' && throwerId > 0) {
          const thrower = this.bot.entities[throwerId];
          if (thrower?.type === 'player' && thrower.username) return thrower.username;
        }
      }
    } catch {
      // metadata structure varies — fall through
    }

    // Strategy 4: previously known
    for (const [name, info] of this._knownPearls) {
      if (info.entity.id === entity.id) return name;
    }

    // Strategy 5: fallback
    return `__pearl_${entity.id}`;
  }

  /**
   * Read the first non-empty line from a sign block as the player name.
   * Returns null if the block has no entity data or all lines are empty.
   */
  _readSignName(block) {
    try {
      const texts = block.getSignText();
      // texts[0] = front face text (lines joined with \n)
      const front = texts[0] || '';
      const name = front.split('\n').map(l => l.trim()).find(l => l.length > 0);
      return name || null;
    } catch {
      return null;
    }
  }

  /**
   * Find the nearest trapdoor block to a given position within
   * SIGN_TRAPDOOR_RADIUS (Manhattan distance).
   *
   * @param {import('vec3').Vec3} origin
   * @returns {import('prismarine-block').Block|null}
   */
  _findNearestTrapdoor(origin) {
    let best = null;
    let bestDist = Infinity;
    const R = SIGN_TRAPDOOR_RADIUS;

    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          const dist = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (dist === 0 || dist > R) continue;
          const block = this.bot.blockAt(origin.offset(dx, dy, dz));
          if (!block || !block.name.includes('trapdoor')) continue;
          if (dist < bestDist) {
            bestDist = dist;
            best = block;
          }
        }
      }
    }

    return best;
  }

  _findPlayerByUUID(uuid) {
    for (const [username, player] of Object.entries(this.bot.players)) {
      if (!player.uuid) continue;
      const pu = player.uuid.replace(/-/g, '').toLowerCase();
      if (pu === uuid) return username;
    }
    return null;
  }
}

function posKey(pos) {
  return `${pos.x},${pos.y},${pos.z}`;
}

module.exports = PearlScanner;
