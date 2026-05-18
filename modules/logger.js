/**
 * Simple logger with levels and optional file logging.
 * Levels: debug < info < warn < error
 */

const fs = require("fs");
const path = require("path");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABELS = { 0: "DEBUG", 1: "INFO", 2: "WARN", 3: "ERROR" };

class Logger {
  constructor(config) {
    this.level = LEVELS[config?.logging?.level] ?? LEVELS.info;
    this.logToFile = config?.logging?.log_to_file ?? false;
    this.logFile = config?.logging?.log_file ?? "pearl-bot.log";

    if (this.logToFile) {
      this.stream = fs.createWriteStream(
        path.resolve(this.logFile),
        { flags: "a" }
      );
    }
  }

  _format(level, msg) {
    const ts = new Date().toISOString();
    return `[${ts}] [${LEVEL_LABELS[level]}] ${msg}`;
  }

  _write(level, msg) {
    if (level < this.level) return;
    const line = this._format(level, msg);

    const consoleFn =
      level >= LEVELS.error
        ? console.error
        : level >= LEVELS.warn
        ? console.warn
        : console.log;
    consoleFn(line);

    if (this.logToFile && this.stream) {
      this.stream.write(line + "\n");
    }
  }

  debug(msg) {
    this._write(LEVELS.debug, msg);
  }
  info(msg) {
    this._write(LEVELS.info, msg);
  }
  warn(msg) {
    this._write(LEVELS.warn, msg);
  }
  error(msg) {
    this._write(LEVELS.error, msg);
  }

  /** Log a chat message from the server */
  chat(msg) {
    if (this.level <= LEVELS.info) {
      const line = `[CHAT] ${msg}`;
      console.log(line);
      if (this.logToFile && this.stream) this.stream.write(line + "\n");
    }
  }

  /** Flush and close the log file stream. Call during graceful shutdown. */
  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

module.exports = Logger;
