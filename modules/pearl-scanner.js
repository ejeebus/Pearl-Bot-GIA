/**
 * PearlScanner - Scans for ender pearl entities in the stasis chamber
 * and maps them to their controlling trapdoor positions.
 *
 * In a stasis chamber, ender pearls are suspended in bubble columns or water.
 * A trapdoor directly above each pearl keeps it suspended. When the trapdoor
 * is closed (opened == false), the pearl falls and the owner teleports.
 *
 * Events:
 *   'pearl-found'  ({ entity, blockPos, playerName })
 *       - Emitted when a new pearl is detected or an existing pearl changes position.
 *   'pearl-lost'   (playerName)
 *       - Emitted when a previously tracked pearl disappears from scans.
 */

const EventEmitter = require('events');

class PearlScanner extends EventEmitter {
  /**
   * @param {import('mineflayer').Bot} bot - Mineflayer bot instance
   * @param {object} config - Bot configuration
   * @param {object} config.stasis - Stasis chamber config
   * @param {{x:number,y:number,z:number}} config.stasis.chamber_center - Center of the chamber
   * @param {number} config.stasis.scan_radius - Max distance from center to scan for pearls
   * @param {number} config.stasis.scan_interval_ms - Interval between automatic scans
   */
  constructor(bot, config, logger) {
    super();
    this.bot = bot;
    this.config = config;
    this.logger = logger;
    this._scanTimer = null;
    /** @type {Map<string, {entity: object, blockPos: import('vec3').Vec3}>} */
    this._knownPearls = new Map();
    /** @type {Set<number>} entity IDs already warned about missing trapdoor */
    this._noTrapdoorWarned = new Set();
  }

  /**
   * Scan all loaded entities for ender pearls within the configured radius,
   * map each to its controlling trapdoor, and resolve the owning player.
   *
   * @returns {Array<{entity: object, blockPos: import('vec3').Vec3, playerName: string}>}
   */
  scan() {
    const cx = this.config.stasis.chamber_center.x;
    const cy = this.config.stasis.chamber_center.y;
    const cz = this.config.stasis.chamber_center.z;
    const radiusSq = this.config.stasis.scan_radius ** 2;

    const pearls = [];

    for (const entity of Object.values(this.bot.entities)) {
      // Filter: only ender pearl projectiles (Minecraft 1.21.4)
      if (entity.name !== 'ender_pearl') continue;

      // Filter: within configured chamber radius
      const dx = entity.position.x - cx;
      const dy = entity.position.y - cy;
      const dz = entity.position.z - cz;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > radiusSq) continue;

      // Find the trapdoor controlling this pearl — search y-3 to y+3
      let blockPos = null;
      let block = null;
      for (let dy = -5; dy <= 10; dy++) {
        const pos = entity.position.floored().offset(0, dy, 0);
        const b = this.bot.blockAt(pos);
        if (b && b.name.includes('trapdoor')) {
          blockPos = pos;
          block = b;
          break;
        }
      }

      if (!block) {
        // Only warn once per entity to avoid log spam every scan cycle
        if (!this._noTrapdoorWarned.has(entity.id)) {
          this._noTrapdoorWarned.add(entity.id);
          const base = entity.position.floored();
          const nearby = [-1, 1, 3, 5, 7, 10].map(dy => {
            const b = this.bot.blockAt(base.offset(0, dy, 0));
            return `y${dy > 0 ? '+' : ''}${dy}:${b?.name ?? 'null'}`;
          }).join(', ');
          this.logger.warn(`No trapdoor near pearl at ${base} — ${nearby}`);
        }
        continue;
      }
      this._noTrapdoorWarned.delete(entity.id);

      // Resolve which player owns this pearl — sign text takes priority over metadata.
      // Check near the trapdoor first (sign is usually on the wall beside the trapdoor),
      // then fall back to near the pearl itself.
      const signName =
        this._readNearbySign(blockPos, `trapdoor@${blockPos}`) ??
        this._readNearbySign(entity.position.floored(), `pearl@${entity.position.floored()}`);

      if (!signName && !this._noSignWarned?.has(entity.id)) {
        (this._noSignWarned ??= new Set()).add(entity.id);
        this.logger.warn(`No sign found near trapdoor ${blockPos} or pearl ${entity.position.floored()}`);
      }

      const playerName = signName ?? this._resolvePearlOwner(entity);

      pearls.push({ entity, blockPos, playerName });
    }

    return pearls;
  }

  /**
   * Search blocks adjacent to a pearl for a sign and return its first non-empty line.
   * Checks same-level walls first, then above, then below — covering common chamber layouts.
   *
   * @param {import('vec3').Vec3} pearlBlock - Floored pearl position
   * @returns {string|null} Player name from sign text, or null if no sign found
   */
  _readNearbySign(pearlBlock, debugLabel) {
    const offsets = [
      // Same level — 1 and 2 blocks out in each cardinal direction
      [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
      [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2],
      // Directly above (wall sign mounted above trapdoor opening)
      [0, 1, 0], [0, 2, 0],
      // One above, cardinal directions (wall sign 1 block behind and 1 above)
      [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
      [2, 1, 0], [-2, 1, 0], [0, 1, 2], [0, 1, -2],
      // One below
      [0, -1, 0],
      [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
    ];
    for (const [dx, dy, dz] of offsets) {
      const b = this.bot.blockAt(pearlBlock.offset(dx, dy, dz));
      if (!b || !b.name.includes('sign')) continue;
      const pos = pearlBlock.offset(dx, dy, dz);
      const name = this._parseSignText(b);
      if (name) return name;
      // Sign found but couldn't read text — log raw entity for diagnosis
      this.logger.warn(`Sign at ${pos} (from ${debugLabel ?? pearlBlock}) found but text was empty`);
    }
    return null;
  }

  /**
   * Extract the first non-empty text line from a sign block entity.
   * Handles both the 1.20+ front_text.messages format and the legacy Text1-Text4 format.
   *
   * @param {import('prismarine-block').Block} block - A sign block
   * @returns {string|null}
   */
  _parseSignText(block) {
    if (!block.entity) return null;
    try {
      const root = block.entity.value ?? block.entity;
      const frontText = root.front_text?.value ?? root.front_text;
      if (!frontText) return null;

      // messages is TAG_List → {type:"list", value:{type:"compound"|"string", value:[...]}}
      const msgList = frontText.messages?.value?.value;
      if (!Array.isArray(msgList)) return null;

      for (const msg of msgList) {
        const text = this._extractTextComponent(msg);
        if (text) return text;
      }
    } catch {
      // malformed NBT — skip
    }
    return null;
  }

  _extractTextComponent(msg) {
    if (!msg) return null;

    // Case 1: TAG_String — JSON-encoded text component e.g. '{"text":"name"}'
    if (typeof msg === 'string' || msg.type === 'string') {
      const raw = typeof msg === 'string' ? msg : msg.value;
      try {
        const t = JSON.parse(raw);
        return (t.text?.trim() || t.extra?.[0]?.text?.trim()) ?? null;
      } catch {
        return (typeof raw === 'string' ? raw.trim() : null) || null;
      }
    }

    // Case 2: TAG_Compound — raw NBT text component
    // e.g. {text:{type:"string",value:""}, extra:{type:"list",value:{type:"string",value:["name"]}}}
    const comp = msg.type === 'compound' ? msg.value : msg;
    if (!comp) return null;

    // Direct text field
    const direct = comp.text?.value ?? comp.text;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();

    // Extra list of strings
    const extraItems = comp.extra?.value?.value ?? comp.extra?.value ?? comp.extra;
    if (Array.isArray(extraItems)) {
      for (const item of extraItems) {
        const s = typeof item === 'string' ? item : (item?.value ?? null);
        if (typeof s === 'string' && s.trim()) return s.trim();
      }
    }

    return null;
  }

  /**
   * Try to determine which player owns an ender pearl.
   *
   * Resolution strategies (in order):
   *   1. Look for owner UUID in entity metadata and cross-reference bot.players
   *   2. Look for thrower entity ID in metadata and resolve via bot.entities
   *   3. Reuse a previously known name for the same entity.id
   *   4. Fall back to a unique internal identifier
   *
   * @param {object} entity - Mineflayer entity object
   * @returns {string} Player name or fallback identifier
   */
  _resolvePearlOwner(entity) {
    // Strategy 1: UUID in entity metadata → bot.players lookup
    try {
      const meta = entity.metadata;
      if (meta) {
        for (const val of Object.values(meta)) {
          // Full UUID string format: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          if (typeof val === 'string' && val.length === 36 && val.includes('-')) {
            const cleaned = val.replace(/-/g, '').toLowerCase();
            if (/^[0-9a-f]{32}$/.test(cleaned)) {
              const found = this._findPlayerByUUID(cleaned);
              if (found) return found;
            }
          }

          // UUID as int[] array of 4 x int32
          if (Array.isArray(val) && val.length === 4 &&
              val.every((n) => typeof n === 'number')) {
            const hex = val
              .map((n) => (n >>> 0).toString(16).padStart(8, '0'))
              .join('');
            const found = this._findPlayerByUUID(hex);
            if (found) return found;
          }
        }

        // Strategy 2: thrower entity ID at common metadata indices
        const throwerId = meta[8] ?? meta[7];
        if (typeof throwerId === 'number' && throwerId > 0) {
          const thrower = this.bot.entities[throwerId];
          if (thrower && thrower.type === 'player' && thrower.username) {
            return thrower.username;
          }
        }
      }
    } catch {
      // Silently continue to next strategy
    }

    // Strategy 3: if we already tracked this entity, reuse the previous name
    for (const [name, info] of this._knownPearls) {
      if (info.entity.id === entity.id) {
        return name;
      }
    }

    // Strategy 4 (fallback): unique internal identifier
    return `__pearl_${entity.id}`;
  }

  /**
   * Find a player name by their Mojang UUID (dashless).
   * @param {string} uuid - 32-character hex UUID (no dashes)
   * @returns {string|null} Player name, or null if not found
   */
  _findPlayerByUUID(uuid) {
    for (const [username, player] of Object.entries(this.bot.players)) {
      if (!player.uuid) continue;
      const pu = player.uuid.replace(/-/g, '').toLowerCase();
      if (pu === uuid) return username;
    }
    return null;
  }

  /**
   * Start periodic pearl scanning at the configured interval.
   * Performs an immediate scan on call.
   */
  startScanning() {
    if (this._scanTimer) return;

    // Immediate scan
    this._update();

    // Recurring scan
    const interval = this.config.stasis.scan_interval_ms;
    this._scanTimer = setInterval(() => this._update(), interval);

    // Allow the process to exit if this timer is the only thing keeping it alive
    if (this._scanTimer.unref) {
      this._scanTimer.unref();
    }
  }

  /**
   * Stop periodic pearl scanning.
   */
  stopScanning() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
  }

  /**
   * Internal update cycle: runs scan(), diffs against known pearls,
   * and emits 'pearl-found' / 'pearl-lost' events as appropriate.
   */
  _update() {
    const current = this.scan();
    const currentKeys = new Set(current.map((p) => p.playerName));

    // Detect lost pearls
    for (const [name] of this._knownPearls) {
      if (!currentKeys.has(name)) {
        this._knownPearls.delete(name);
        this.emit('pearl-lost', name);
      }
    }

    // Detect new pearls or moved pearls
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
   * Get the pearl info for a specific player.
   *
   * @param {string} playerName - The Minecraft player name
   * @returns {{entity: object, blockPos: import('vec3').Vec3}|null} Pearl info or null
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

  /**
   * Get a shallow copy of all currently tracked pearls.
   * @returns {Map<string, {entity: object, blockPos: import('vec3').Vec3}>}
   */
  getKnownPearls() {
    return new Map(this._knownPearls);
  }
}

module.exports = PearlScanner;
