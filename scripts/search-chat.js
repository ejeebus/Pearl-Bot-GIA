/**
 * CLI tool to search the chat-log SQLite database.
 *
 * Usage:
 *   node scripts/search-chat.js --sender Notch
 *   node scripts/search-chat.js --contains "give me"
 *   node scripts/search-chat.js --flagged
 *   node scripts/search-chat.js --sender Notch --contains diamond --limit 50
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let config;
try {
  config = require('../config.json');
} catch {
  config = {};
}

const dbPath = path.resolve(__dirname, '..', config?.chat_logging?.db_path || 'chat-log.db');

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const sender = getArg('sender');
const contains = getArg('contains');
const flaggedOnly = args.includes('--flagged');
const limit = parseInt(getArg('limit') || '100', 10);

const db = new DatabaseSync(dbPath);

const clauses = [];
const params = [];
if (sender) {
  clauses.push('LOWER(sender) = LOWER(?)');
  params.push(sender);
}
if (contains) {
  clauses.push('message LIKE ?');
  params.push(`%${contains}%`);
}
if (flaggedOnly) {
  clauses.push('flagged = 1');
}

const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
const stmt = db.prepare(
  `SELECT id, timestamp, sender, message, flagged FROM messages ${where} ORDER BY id DESC LIMIT ?`
);
const rows = stmt.all(...params, limit);

if (rows.length === 0) {
  console.log('No matching messages found.');
} else {
  for (const row of rows.reverse()) {
    const flag = row.flagged ? ' [FLAGGED]' : '';
    console.log(`[${row.timestamp}] ${row.sender ?? '(unknown)'}: ${row.message}${flag}`);
  }
  console.log(`\n${rows.length} message(s) shown (limit ${limit}).`);
}

db.close();
