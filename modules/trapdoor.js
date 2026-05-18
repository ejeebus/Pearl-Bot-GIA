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
 *   const controller = new TrapdoorController(bot);
 *   await controller.loadPearl('Player1', trapdoorBlock);
 */

const TRAPDOOR_WAIT_MS = 2000;

class TrapdoorController {
  constructor(bot) {
    this.bot = bot;
  }

  _assertTrapdoor(block) {
    if (!block || !block.name || !block.name.includes('trapdoor')) {
      throw new Error(
        `Block is not a trapdoor: ${block?.name ?? 'null'}`
      );
    }
  }

  /**
   * Close a single trapdoor. No-op if already closed.
   * @param {import('prismarine-block').Block} block - The trapdoor block
   * @returns {Promise<boolean>} Whether the trapdoor state was changed (was open, now closed)
   */
  async closeTrapdoor(block) {
    this._assertTrapdoor(block);

    const props = block.getProperties();
    if (!props.open) {
      console.log(`[Trapdoor] Trapdoor at ${block.position} is already closed, skipping`);
      return false;
    }

    console.log(`[Trapdoor] Closing trapdoor at ${block.position}`);
    await this.bot.activateBlock(block);
    console.log(`[Trapdoor] Trapdoor closed at ${block.position}`);
    return true;
  }

  /**
   * Open a single trapdoor. No-op if already open.
   * @param {import('prismarine-block').Block} block - The trapdoor block
   * @returns {Promise<boolean>} Whether the trapdoor state was changed (was closed, now open)
   */
  async openTrapdoor(block) {
    this._assertTrapdoor(block);

    const props = block.getProperties();
    if (props.open) {
      console.log(`[Trapdoor] Trapdoor at ${block.position} is already open, skipping`);
      return false;
    }

    console.log(`[Trapdoor] Opening trapdoor at ${block.position}`);
    await this.bot.activateBlock(block);
    console.log(`[Trapdoor] Trapdoor opened at ${block.position}`);
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

    const props = block.getProperties();
    if (!props.open) {
      console.log(`[Trapdoor] Trapdoor at ${block.position} is not open, cannot toggle`);
      return { success: false, playerName: null };
    }

    // Listen for any player teleportation during the load window
    let teleportedPlayer = null;
    const teleportHandler = (player) => {
      teleportedPlayer = player.username;
      console.log(`[Trapdoor] Detected teleport for ${player.username}`);
    };
    this.bot.on('playerTeleport', teleportHandler);

    try {
      // Step 1: Close the trapdoor — this releases the pearl entity
      console.log(`[Trapdoor] Closing trapdoor at ${block.position} to release pearl`);
      await this.bot.activateBlock(block);

      // Step 2: Wait for the pearl to fall and the player to teleport
      console.log(`[Trapdoor] Waiting ${TRAPDOOR_WAIT_MS}ms for pearl fall and teleport`);
      await new Promise((resolve) => setTimeout(resolve, TRAPDOOR_WAIT_MS));

      // Step 3: Re-open the trapdoor for future use
      console.log(`[Trapdoor] Re-opening trapdoor at ${block.position}`);
      await this.bot.activateBlock(block);
      console.log(`[Trapdoor] Trapdoor re-opened successfully`);

      return {
        success: true,
        playerName: teleportedPlayer,
      };
    } catch (err) {
      console.error(`[Trapdoor] Error during toggle: ${err.message}`);
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
    console.log(`[Trapdoor] Starting pearl load for ${playerName}`);

    const result = await this.toggleTrapdoor(trapdoorBlock);

    if (result.success) {
      const who = result.playerName || playerName;
      console.log(`[Trapdoor] Pearl load succeeded for ${who}`);
    } else {
      console.error(`[Trapdoor] Pearl load failed for ${playerName}`);
    }

    return result.success;
  }
}

module.exports = TrapdoorController;
