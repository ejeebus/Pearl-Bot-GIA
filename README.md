# Pearl-Bot-GIA

> A Mineflayer-based stasis pearl management bot for **2b2t**, built for the GIA.  
> Automatically tracks ender pearls in a stasis chamber and loads them on demand — via in-game chat or Discord.

---

## Features

- **Pearl Scanner** — Continuously scans the stasis chamber for ender pearl entities and maps them to their owners
- **Pearl Loading** — Opens the trapdoor above a pearl to trigger teleportation, then resets it automatically
- **Discord Integration** — Request pearl loads from a Discord channel with permission-gated commands
- **Anti-AFK** — Cycles through subtle actions (look, sneak, jump) to prevent idle kicks
- **Queue Handler** — Auto-reconnects through the 2b2t queue with exponential backoff
- **Intruder Detection** — Alerts and optionally disconnects when non-whitelisted players enter render distance
- **Recruiter** — Sends periodic recruitment messages in global chat
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

#### Bot Connection

```json
"bot": {
  "username": "YourBotUsername",
  "auth": "microsoft",
  "host": "ingress.2b2t.org",
  "port": 25565,
  "version": "1.21.4"
}
```

#### Stasis Chamber

```json
"stasis": {
  "chamber_center": { "x": 100, "y": 64, "z": -200 },
  "scan_radius": 15,
  "scan_interval_ms": 3000
}
```

Set `chamber_center` to the center coordinates of your pearl chamber. The bot will scan within `scan_radius` blocks every `scan_interval_ms` milliseconds.

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
  "interval_ms": 300000,
  "mode": "look_around",
  "modes": ["look_around", "sneak_toggle", "small_jump"]
}
```

| Mode | Description |
|------|-------------|
| `look_around` | Slightly varies yaw/pitch |
| `sneak_toggle` | Quick sneak then release |
| `small_jump` | Jumps in place |
| `chat_ping` | Sends an invisible chat message |

Set `mode` to a single value, or omit it to rotate through `modes` automatically.

#### Queue & Reconnection

```json
"queue": {
  "auto_reconnect": true,
  "max_reconnect_attempts": 0,
  "reconnect_delay_base_ms": 30000,
  "reconnect_delay_max_ms": 600000
}
```

`max_reconnect_attempts: 0` means infinite retries. Reconnect delay uses exponential backoff with ±20% jitter.

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
└── modules/
    ├── pearl-scanner.js  # Scans for pearl entities and maps owners
    ├── trapdoor.js       # Toggles trapdoors to trigger pearl loads
    ├── commands.js       # In-game chat command handler
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

---

## Stopping the Bot

Press `Ctrl+C` or send `SIGTERM`. All modules shut down cleanly — timers are cleared, event listeners removed, and log files are flushed.
