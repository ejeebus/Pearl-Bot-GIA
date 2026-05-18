/**
 * Whitelist manager - controls which players can request pearl loads.
 * Case-insensitive matching, supports dynamic add/remove at runtime.
 */

class WhitelistManager {
  constructor(config) {
    this.players = new Set(
      (config.whitelist || []).map((p) => p.toLowerCase())
    );
  }

  /** Check if a player is authorized */
  isAuthorized(playerName) {
    return this.players.has(playerName.toLowerCase());
  }

  /** Add a player to the whitelist */
  add(playerName) {
    const lower = playerName.toLowerCase();
    if (this.players.has(lower)) return false;
    this.players.add(lower);
    return true;
  }

  /** Remove a player from the whitelist */
  remove(playerName) {
    return this.players.delete(playerName.toLowerCase());
  }

  /** List all whitelisted players */
  list() {
    return [...this.players];
  }

  /** Get count */
  get count() {
    return this.players.size;
  }
}

module.exports = WhitelistManager;
