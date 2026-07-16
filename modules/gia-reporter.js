/**
 * GiaReporter — pushes each bot's live position + nearby-player sightings to the
 * GIA website's live operations map (gia2b2t.com/map).
 *
 * One reporter for the whole process. On an interval it walks the bot network,
 * and for every in-world bot reports:
 *   - a position fix  → POST /api/bots/ping      (fleet marker on the map)
 *   - every non-fleet player in render distance → POST /api/sightings/ping
 *
 * Auth is a shared ingest token (GIA_INGEST_TOKEN) that must match
 * BOT_INGEST_TOKEN on the website. It is DIFFERENT from any admin token, and is
 * read from the environment only — never commit it.
 *
 * Reporting is best-effort and completely fire-and-forget: a network error,
 * a 4xx, or the site being down must NEVER disturb the pearl bots. All failures
 * are swallowed (logged at debug).
 *
 * Config (all optional; env wins over config.json `gia_reporter`):
 *   GIA_INGEST_URL    base site origin, e.g. https://gia2b2t.com
 *                     (a full .../api/bots/ping URL is also accepted — the path
 *                      is stripped back to the origin)
 *   GIA_INGEST_TOKEN  the shared ingest token
 *   config.gia_reporter = {
 *     enabled, interval_seconds (default 7),
 *     positions (default true), sightings (default true),
 *     report_whitelisted (default false — skip known friendly players)
 *   }
 */
class GiaReporter {
  /**
   * @param {object} config    the full app config (reads config.gia_reporter)
   * @param {import('./network')} network  the bot network (iterated each tick)
   * @param {object} whitelist  WhitelistManager (to optionally skip friendlies)
   * @param {object} logger
   */
  constructor(config, network, whitelist, logger) {
    this.network = network;
    this.whitelist = whitelist;
    this.logger = logger;

    const rc = (config && config.gia_reporter) || {};
    this.baseUrl = this._origin(process.env.GIA_INGEST_URL || rc.ingest_url || '');
    this.token = process.env.GIA_INGEST_TOKEN || rc.ingest_token || '';
    this.intervalMs = Math.max(3, rc.interval_seconds || 7) * 1000;
    this.reportPositions = rc.positions !== false;
    this.reportSightings = rc.sightings !== false;
    this.reportWhitelisted = rc.report_whitelisted === true;
    this.enabled = rc.enabled !== false && !!this.baseUrl && !!this.token;

    this._timer = null;
    this._warned = false;
  }

  /** Strip any path from a URL so we always POST to <origin>/api/... */
  _origin(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}`;
    } catch {
      // not a full URL (e.g. "gia2b2t.com") — best-effort
      return url.replace(/\/api\/.*$/, '').replace(/\/+$/, '');
    }
  }

  start() {
    if (!this.enabled) {
      if ((process.env.GIA_INGEST_URL || this.token) && !(this.baseUrl && this.token)) {
        this.logger.warn('GIA reporter: need BOTH GIA_INGEST_URL and GIA_INGEST_TOKEN — disabled');
      } else {
        this.logger.info('GIA reporter disabled (no GIA_INGEST_URL/GIA_INGEST_TOKEN)');
      }
      return;
    }
    this.logger.info(`GIA reporter → ${this.baseUrl} every ${this.intervalMs / 1000}s`);
    this._timer = setInterval(() => { this._tick().catch(() => {}); }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _dimOf(bot) {
    const d = String((bot.game && bot.game.dimension) || '');
    if (d.includes('nether')) return 'NETHER';
    if (d.includes('end')) return 'END';
    return 'OVERWORLD';
  }

  /** stable, fleet-namespaced id so pearl bots never collide with other fleets */
  _idFor(pb) {
    return 'pearl:' + ((pb.config && pb.config.bot && pb.config.bot.username) || pb.name || 'bot');
  }

  async _tick() {
    const botFixes = [];
    const sightings = [];

    // usernames belonging to our own fleet — never report ourselves as sightings
    const selfNames = new Set();
    for (const pb of this.network.bots) {
      if (pb.bot && pb.bot.username) selfNames.add(pb.bot.username.toLowerCase());
    }

    for (const pb of this.network.bots) {
      const bot = pb.bot;
      if (!bot || !bot.entity || !bot.entity.position) continue; // not in world (queue/offline)
      const dim = this._dimOf(bot);
      const p = bot.entity.position;

      if (this.reportPositions) {
        const meta = {};
        if (typeof bot.health === 'number') meta.health = Math.round(bot.health);
        botFixes.push({
          bot_id: this._idFor(pb),
          name: pb.name || bot.username,
          fleet: 'pearl',
          dimension: dim,
          x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z),
          status: 'ONLINE',
          meta,
        });
      }

      if (this.reportSightings && bot.entities) {
        for (const id in bot.entities) {
          const e = bot.entities[id];
          if (!e || e.type !== 'player' || !e.username || !e.position) continue;
          const uname = e.username;
          if (uname === bot.username) continue;
          if (selfNames.has(uname.toLowerCase())) continue;
          if (!this.reportWhitelisted && this.whitelist && this.whitelist.isAuthorized(uname)) continue;
          sightings.push({
            player: uname,
            dimension: dim,
            x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z),
            source: this._idFor(pb),
          });
        }
      }
    }

    if (this.reportPositions && botFixes.length) await this._post('/api/bots/ping', { bots: botFixes });
    if (this.reportSightings && sightings.length) await this._post('/api/sightings/ping', { sightings });
  }

  async _post(path, body) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok && !this._warned) {
        this._warned = true; // warn once so a misconfig is visible without spamming
        this.logger.warn(`GIA reporter: ${path} returned ${res.status} (check token/URL). Suppressing further warnings.`);
      } else if (res.ok) {
        this._warned = false;
      }
    } catch (e) {
      // network/abort — swallow; the map layer is non-critical
      this.logger.debug?.(`GIA reporter ${path} failed: ${e.message}`);
    }
  }
}

module.exports = GiaReporter;
