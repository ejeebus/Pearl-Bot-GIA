const crypto = require('crypto');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MESSAGE = 'The GIA wants YOU! Become a member today';

class Recruiter {
  constructor(bot, config, logger) {
    this.bot = bot;
    this.logger = logger;
    this._intervalMs = config?.recruiter?.interval_ms ?? DEFAULT_INTERVAL_MS;
    this._message = config?.recruiter?.message ?? DEFAULT_MESSAGE;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.send(), this._intervalMs);
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
    const msg = `${this._message} [${hash}]`;
    let echoed = false;

    const onMessage = (rawMsg) => {
      if (rawMsg.includes(hash)) {
        echoed = true;
        this.logger.info(`[RECRUIT] Server confirmed broadcast [${hash}]`);
      }
    };

    try {
      this.bot.on('messagestr', onMessage);
      this.bot.chat(msg);
      this.logger.info(`Sent recruitment message [${hash}]`);
    } catch (err) {
      this.bot.removeListener('messagestr', onMessage);
      this.logger.error(`Failed to send recruitment message: ${err.message}`);
      return;
    }

    setTimeout(() => {
      this.bot.removeListener('messagestr', onMessage);
      if (!echoed) {
        this.logger.warn(`[RECRUIT] No echo for [${hash}] — server dropped or filtered the message`);
      }
    }, 5000);
  }
}

module.exports = Recruiter;
