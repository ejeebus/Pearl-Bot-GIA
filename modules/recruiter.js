const crypto = require('crypto');

const INTERVAL_MS = 5 * 60 * 1000;
const MESSAGE = 'The GIA wants YOU! Become a member today';

class Recruiter {
  constructor(bot, logger) {
    this.bot = bot;
    this.logger = logger;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.send(), INTERVAL_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  send() {
    const hash = crypto.randomBytes(6).toString('hex');
    const msg = `${MESSAGE} [${hash}]`;
    try {
      this.bot.chat(msg);
      this.logger.info(`Sent recruitment message [${hash}]`);
    } catch (err) {
      this.logger.error(`Failed to send recruitment message: ${err.message}`);
    }
  }
}

module.exports = Recruiter;
