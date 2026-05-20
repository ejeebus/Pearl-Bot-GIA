/**
 * Trapdoor controller for stasis pearl chamber.
 * Controls trapdoors above suspended ender pearls
 * to release and trigger player teleportation.
 *
 * Mechanics:
 *   Closing a trapdoor above a stasis pearl makes the pearl entity fall,
 *   triggering the teleport. After 1-2 seconds the trapdoor is re-opened
 *   so the chamber can be reused.
 *
 * Usage:
 *   const TrapdoorController = require('./modules/trapdoor');
 *   const controller = new TrapdoorController(bot, logger);
 *   await controller.loadPearl('Player1', trapdoorBlock);
 */

const TRAPDOOR_WAIT_MS = 2000;

class TrapdoorController {
  constructor(bot, logger) {
    this.bot = bot;
    this.logger = logger;
  }

  _assertTrapdoor(block) {
    if (!block || !block.name || !block.name.includes('trapdoor')) {
      throw new Error(
        `Block is not a trapdoor: ${block?.name ?? 'null'}`
      );
    }
  }

  /** Re-fetch a block from the world to get current server-side state. */
  _refresh(block) {
    return this.bot.blockAt(block.position);
  }

  /**
   * Close a single trapdoor. No-op if already closed.
   * @param {import('prismarine-block').Block} block - The trapdoor block
   * @returns {Promise<boolean>} Whether the trapdoor state was changed (was open, now closed)
   */
  async closeTrapdoor(block) {
    this._assertTrapdoor(block);

    const current = this._refresh(block);
    const props = current.getProperties();
    if (!props.open) {
      this.logger.debug(`Trapdoor at ${block.position} is already closed, skipping`);
      return false;
    }

    this.logger.debug(`Closing trapdoor at ${block.position}`);
    await this.bot.activateBlock(current);
    this.logger.debug(`Trapdoor closed at ${block.position}`);
    return true;
  }

  /**
   * Open a single trapdoor. No-op if already open.
   * @param {import('prismarine-block').Block} block - The trapdoor block
   * @returns {Promise<boolean>} Whether the trapdoor state was changed (was closed, now open)
   */
  async openTrapdoor(block) {
    this._assertTrapdoor(block);

    const current = this._refresh(block);
    const props = current.getProperties();
    if (props.open) {
      this.logger.debug(`Trapdoor at ${block.position} is already open, skipping`);
      return false;
    }

    this.logger.debug(`Opening trapdoor at ${block.position}`);
    await this.bot.activateBlock(current);
    this.logger.debug(`Trapdoor opened at ${block.position}`);
    return true;
  }

  /**
   * Toggle a trapdoor: close it (if open), wait for the pearl to fall
   * and trigger teleportation, then re-open it for future use.
   *
   * Listens for Mineflayer's `playerTeleport` event during the window
   * to capture which player was teleported.
   *
   * @param {import('prismarine-block').Block} block - The trapdoor block
   * @returns {Promise<{success: boolean, playerName: string|null}>}
   *   - success: true if the close/reopen cycle completed without error
   *   - playerName: the player who teleported, or null if none detected
   */
  async toggleTrapdoor(block) {
    this._assertTrapdoor(block);

    const current = this._refresh(block);
    const props = current.getProperties();
    if (!props.open) {
      this.logger.warn(`Trapdoor at ${block.position} is not open, cannot toggle`);
      return { success: false, playerName: null };
    }

    // Listen for any player teleportation during the load window
    let teleportedPlayer = null;
    const teleportHandler = (player) => {
      teleportedPlayer = player.username;
      this.logger.debug(`Detected teleport for ${player.username}`);
    };
    this.bot.on('playerTeleport', teleportHandler);

    try {
      // Step 1: Close the trapdoor — this releases the pearl entity
      this.logger.debug(`Closing trapdoor at ${block.position} to release pearl`);
      await this.bot.activateBlock(current);

      // Step 2: Wait for the pearl to fall and the player to teleport
      await new Promise((resolve) => setTimeout(resolve, TRAPDOOR_WAIT_MS));

      // Step 3: Re-open the trapdoor for future use (re-fetch for current state)
      const reopenBlock = this._refresh(block);
      this.logger.debug(`Re-opening trapdoor at ${block.position}`);
      await this.bot.activateBlock(reopenBlock);
      this.logger.debug(`Trapdoor re-opened at ${block.position}`);

      return {
        success: true,
        playerName: teleportedPlayer,
      };
    } catch (err) {
      this.logger.error(`Error during trapdoor toggle at ${block.position}: ${err.message}`);
      return { success: false, playerName: null };
    } finally {
      this.bot.removeListener('playerTeleport', teleportHandler);
    }
  }

  /**
   * Full pearl load sequence: close trapdoor, wait for pearl to fall
   * and teleport the player, then re-open the trapdoor.
   *
   * Verifies the trapdoor is open before beginning the sequence.
   *
   * @param {string} playerName - The player whose pearl is being loaded
   * @param {import('prismarine-block').Block} trapdoorBlock - The trapdoor block above the pearl
   * @returns {Promise<boolean>} Whether the load completed successfully
   */
  async loadPearl(playerName, trapdoorBlock) {
    this.logger.info(`Starting pearl load for ${playerName} — trapdoor at ${trapdoorBlock?.position}`);

    const result = await this.toggleTrapdoor(trapdoorBlock);

    if (result.success) {
      const who = result.playerName || playerName;
      this.logger.info(`Pearl load succeeded for ${who}`);
    } else {
      this.logger.error(`Pearl load failed for ${playerName}`);
    }

    return result.success;
  }
}

module.exports = TrapdoorController;
