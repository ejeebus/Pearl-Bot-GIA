# Pearl-Bot-GIA

> A Mineflayer-based stasis pearl management bot for **2b2t**, built for the GIA.  
> Automatically tracks ender pearls in a stasis chamber and loads them on demand — via in-game chat or Discord.

---

## Features

- **Pearl Scanner** — Continuously scans the stasis chamber for ender pearl entities and maps them to their owners
- **Pearl Loading** — Opens the trapdoor above a pearl to trigger teleportation, then resets it automatically
- **Pathfinding** — Walks to the requested pearl's trapdoor (via `mineflayer-pathfinder`), loads it, and returns to the chamber center — so it works even in large chambers where trapdoors are out of reach
- **Discord Integration** — Request pearl loads from a Discord channel with permission-gated commands
- **Anti-AFK** — Cycles through subtle actions (look, sneak, jump) to prevent idle kicks
- **Queue Handler** — Auto-reconnects through the 2b2t queue with exponential backoff
- **Intruder Detection** — Alerts and optionally disconnects when non-whitelisted players enter render distance
- **Recruiter** — Sends periodic recruitment messages in global chat
- **Chat Logging** — Records all server chat to a local SQLite database for later review/search, with optional keyword flagging
- **GIA Map Reporter** — Optionally pushes each in-world bot's position and nearby-player sightings to the [gia2b2t.com](https://gia2b2t.com) live operations map (fire-and-forget; never disturbs the bots)
- **Logging** — Dual console + file logging with configurable verbosity

---

## Requirements

- **Node.js v22** (see `.nvmrc`) — use [nvm](https://github.com/nvm-sh/nvm) to manage versions
- A **Microsoft account** for the bot (Mojang auth also supported)
- A stasis chamber built in-game with trapdoors above each pearl *(see [Chamber Setup](#chamber-setup))*

---

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/ejeebus/pearl-bot-gia.git
cd pearl-bot-gia

# 2. Use the correct Node version
nvm use

# 3. Install dependencies
npm install

# 4. Copy the example config files
cp config.example.json config.json
cp .env.example .env
```

---

## Configuration

### `.env` — Credentials

```env
# Microsoft account for the bot
MICROSOFT_EMAIL=your_bot_email@example.com
MICROSOFT_PASSWORD=your_bot_password

# Discord (optional)
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_ID=1234567890
```

> Credentials in `.env` are never committed — `.gitignore` covers this file.

---

### `config.json` — Bot Settings

#### Bots & Chambers

The bot runs one or more accounts in a single process — each account watches its own stasis chamber. List them under `bots`:

```json
"bots": [
  {
    "name": "chamber-1",
    "username": "bot1@example.com",
    "auth": "microsoft",
    "host": "ingress.2b2t.org",
    "port": 25565,
    "version": "1.21.4",
    "stasis": {
      "chamber_center": { "x": 0, "y": 0, "z": 0 },
      "scan_radius": 15,
      "scan_interval_ms": 3000
    }
  },
  {
    "name": "chamber-2",
    "username": "bot2@example.com",
    "auth": "microsoft",
    "host": "ingress.2b2t.org",
    "port": 25565,
    "version": "1.21.4",
    "stasis": {
      "chamber_center": { "x": 100, "y": 64, "z": -200 },
      "scan_radius": 15,
      "scan_interval_ms": 3000
    },
    "recruiter": { "enabled": false }
  }
]
```

- **Each bot needs its own Microsoft account** — two bots can't share one login. Set each account via its `username`. On first run, each bot prints a `microsoft.com/link` device code to the console; sign in once and the token is cached.
- Set each bot's `stasis.chamber_center` to the center of *its* chamber. Pearl requests (in-game or Discord) are automatically routed to whichever bot owns the target player's pearl.
- When a pearl is requested, the bot **pathfinds to that pearl's trapdoor**, loads it, then **returns to `chamber_center`**. This makes `chamber_center` a real standing spot the bot returns to — make sure it's somewhere the bot can actually stand. Optional per-bot `stasis` keys tune this:
  - `reach_range` (default `3`) — how close the bot gets to a trapdoor before activating it. Must stay under ~4.5 (Minecraft reach). Increase if the nearest standable block is a bit far; decrease for tighter aim.
  - `home` `{x,y,z}` (default `chamber_center`) — an explicit spot to return to, if the center isn't where you want the bot to idle.
  - `home_radius` (default `1`) — how close to `home` counts as "arrived".
- Each bot inherits the shared top-level `anti_afk` / `queue` / `intruder` / `recruiter` blocks, but any bot can override one by including it in its own entry (e.g. `"recruiter": { "enabled": false }` above so only one bot sends recruitment messages).
- The **first bot** in the list is the "primary" — it's the single responder for `!pearls` lists and "no pearl found" replies so multiple bots don't answer at once.

> **Single bot?** A legacy `"bot": { ... }` + top-level `"stasis": { ... }` config still works — it's treated as a one-element `bots` list.

#### Whitelist

```json
"whitelist": ["Player1", "Player2", "Player3"]
```

Only whitelisted players can trigger pearl loads via in-game commands. Matching is case-insensitive.

#### Discord Integration *(optional)*

```json
"discord": {
  "enabled": true,
  "token": "from .env",
  "channel_id": "CHANNEL_ID_HERE",
  "prefix": "!pearl",
  "whitelist": ["DiscordUser1", "DiscordUser2"]
}
```

If `discord.whitelist` is omitted, the Minecraft whitelist is used for Discord too.

#### Anti-AFK

```json
"anti_afk": {
  "enabled": true,
  "interval_ms": 120000,
  "patrol": true
}
```

Each cycle the bot swings its arm, **toggles a dedicated block** (see `afk_toggle` below), and — if `patrol` is on — takes one sneaked step back and forth so it visibly moves without walking off the platform.

> **Why a block toggle?** On 2b2t, rotating the head or jumping in place does **not** reset the AFK timer — you get kicked within ~5 minutes, and even continuous walking is kicked at ~30 minutes. Only **interacting with blocks** (breaking/placing, or toggling a door/lever/trapdoor) reliably keeps you connected. So each bot needs a block to flip.

**Set up the toggle block (per bot):** place a **lever** (or a door, or a spare trapdoor that is **not** above a stored pearl) next to the bot, and put its coordinates in that bot's `stasis.afk_toggle`:

```json
"stasis": {
  "chamber_center": { "x": 100, "y": 64, "z": -200 },
  "scan_radius": 15,
  "afk_toggle": { "x": 102, "y": 64, "z": -200 }
}
```

Keep `interval_ms` under ~4 minutes (default 2 min) so a toggle always lands inside 2b2t's ~5-minute idle window. Without `afk_toggle` the bot logs a warning and will still eventually be AFK-kicked. Set `patrol: false` if you'd rather it not move at all.

#### Queue & Reconnection

```json
"queue": {
  "auto_reconnect": true,
  "max_reconnect_attempts": 0,
  "reconnect_delay_base_ms": 30000,
  "reconnect_delay_max_ms": 600000,
  "queue_heartbeat_ms": 60000,
  "queue_stuck_timeout_ms": 900000
}
```

`max_reconnect_attempts: 0` means infinite retries. Reconnect delay uses exponential backoff with ±20% jitter.

#### Live queue counter

While waiting in the 2b2t queue the bot logs a live position counter, read from
the server's tab-list footer (2b2t reports the position there, not in chat):

```
[QUEUE] In queue — position 312, server ETA 2h 40m
[QUEUE] Position: 311  -1  ~2.4/min  ETA ~2h09m
[QUEUE] Position: 310  -1  ~2.4/min  ETA ~2h08m
[QUEUE] Reached the front — connecting to the server
```

Each line shows the current position, the change since the last update, the
observed movement rate, and an ETA estimated from that rate (falling back to
2b2t's own ETA text until enough samples are collected).

| Key | Meaning |
|-----|---------|
| `queue_heartbeat_ms` | How often to re-log the position when it hasn't changed, so the log shows the bot is alive during static stretches (default 60s; `0` disables). |
| `queue_stuck_timeout_ms` | If the position hasn't advanced for this long, log a WARN — usually a 2b2t restart or a frozen queue (default 15m; `0` disables). |

#### Intruder Detection

```json
"intruder": {
  "enabled": true,
  "auto_disconnect": true,
  "reconnect_delay_ms": 300000
}
```

When a non-whitelisted player enters render distance, the bot sends a Discord alert. If `auto_disconnect` is `true`, it disconnects and waits `reconnect_delay_ms` before reconnecting.

#### Recruiter

```json
"recruiter": {
  "message": "The GIA wants YOU! Become a member today",
  "interval_ms": 300000
}
```

#### Chat Logging

```json
"chat_logging": {
  "enabled": true,
  "db_path": "chat-log.db",
  "flag_keywords": []
}
```

Every message seen in server chat is recorded to a local SQLite database (`db_path`) with sender, timestamp, and message body — useful for vetting players or investigating incidents later. Add words/phrases to `flag_keywords` (case-insensitive) to flag matching messages; flagged messages are logged at WARN level and, if Discord is enabled, posted immediately to the configured channel.

Search the log from the command line:

```bash
node scripts/search-chat.js --sender Notch
node scripts/search-chat.js --contains "give me"
node scripts/search-chat.js --flagged
node scripts/search-chat.js --sender Notch --contains diamond --limit 50
```

#### GIA Map Reporter

```json
"gia_reporter": {
  "enabled": true,
  "interval_seconds": 7,
  "positions": true,
  "sightings": true,
  "report_whitelisted": false
}
```

Pushes live telemetry to the GIA website's operations map at
[gia2b2t.com/map](https://gia2b2t.com/map). On each interval it reports, for
every **in-world** bot, a position fix (`positions`) and every non-fleet player
in render distance as a **sighting** (`sightings`). Whitelisted (friendly)
players are skipped unless `report_whitelisted` is `true`. Reporting is entirely
fire-and-forget — a slow or down website can never disturb the bots.

Credentials come from the environment (never `config.json`):

```env
GIA_INGEST_URL=https://gia2b2t.com
GIA_INGEST_TOKEN=<must equal the website's BOT_INGEST_TOKEN>
```

If either is unset the reporter stays disabled. The token must match the
website's `BOT_INGEST_TOKEN` and be different from any admin token — treat it
like a password and keep it out of git.

#### Logging

```json
"logging": {
  "level": "info",
  "log_to_file": true,
  "log_file": "pearl-bot.log"
}
```

Levels: `debug` → `info` → `warn` → `error`

---

## Chamber Setup

For the pearl scanner to work correctly, the stasis chamber must be built with:

1. Each player's ender pearl suspended in a **water/bubble column**
2. A **trapdoor directly above each pearl** (the bot toggles this to load the pearl)
3. *(Recommended)* A **sign** near each pearl/trapdoor with the player's username — this is the most reliable way for the bot to identify pearl ownership

The bot also resolves ownership via entity UUID/thrower metadata and cached name mappings as fallbacks.

---

## Running the Bot

```bash
# Production
npm start

# Development (auto-reload on file changes)
npm run dev
```

On startup the bot will:
1. Connect and authenticate via Microsoft OAuth
2. Queue through 2b2t
3. Walk briefly after spawning to clear the per-session chat mute
4. Begin scanning the chamber and accepting commands

---

## Commands

### In-Game Chat

All commands require the sender to be on the whitelist.

| Command | Description |
|---------|-------------|
| `!pearl` | Load your own pearl |
| `!pearl <player>` | Load another player's pearl |
| `!pearls` | List all currently tracked pearls |
| `!recruit` | Manually send the recruitment message |

### Discord

In the configured Discord channel:

| Command | Description |
|---------|-------------|
| `!pearl <MinecraftUsername>` | Load the specified player's pearl |

The bot responds with a rich embed showing success, an error, or a permission denial. On success, it includes the pearl's coordinates.

---

## Project Structure

```
Pearl-Bot-GIA/
├── index.js              # Entry point — initializes and wires all modules
├── config.example.json   # Config template
├── .env.example          # Credentials template
├── scripts/
│   └── search-chat.js    # CLI tool to search the chat-log database
└── modules/
    ├── pearl-bot.js      # One bot's lifecycle + its per-bot modules
    ├── network.js        # Coordinates bots; routes pearl requests to the owning chamber
    ├── pearl-scanner.js  # Scans for pearl entities and maps owners
    ├── trapdoor.js       # Toggles trapdoors to trigger pearl loads
    ├── navigator.js      # Pathfinds to a trapdoor and back to chamber center
    ├── commands.js       # In-game chat command handler
    ├── chat-utils.js     # Shared chat parsing helpers (sender extraction, prefix stripping)
    ├── chat-logger.js    # Records chat to SQLite, with keyword flagging
    ├── discord.js        # Discord bot integration
    ├── anti-afk.js       # AFK prevention
    ├── queue.js          # 2b2t queue + auto-reconnect
    ├── intruder.js       # Intruder detection and alerts
    ├── recruiter.js      # Periodic recruitment messages
    ├── whitelist.js      # Whitelist management
    └── logger.js         # Console + file logging
```

---

## Common Tasks

| Task | Where to change |
|------|----------------|
| Add a player to the whitelist | `config.json` → `whitelist` array |
| Set stasis chamber coordinates | `config.json` → `stasis.chamber_center` |
| Enable Discord | `config.json` → `discord.enabled: true` + `.env` tokens |
| Change anti-AFK behavior | `config.json` → `anti_afk.mode` |
| Enable intruder auto-disconnect | `config.json` → `intruder.auto_disconnect: true` |
| View bot logs | `pearl-bot.log` (if `logging.log_to_file` is enabled) |
| Search chat logs | `node scripts/search-chat.js --sender <name>` (see [Chat Logging](#chat-logging)) |
| Flag keywords in chat | `config.json` → `chat_logging.flag_keywords` array |

---

## Stopping the Bot

Press `Ctrl+C` or send `SIGTERM`. All modules shut down cleanly — timers are cleared, event listeners removed, and log files are flushed.
