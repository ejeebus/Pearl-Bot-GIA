# Handoff — Multi-Bot Network refactor

**Branch:** `multi-bot-network` (based on `5fc95b5`, the chat-logging commit)
**Goal:** Run multiple bot accounts in one `npm start`, each watching its **own
stasis chamber**, with pearl requests (in-game + Discord) auto-routed to whichever
bot owns the target player's pearl. Second Microsoft account already exists.

---

## Status: integrated and merged into `main` (commit `dd188ae`)

All code is written, syntax-checked (`node -c`), and functionally smoke-tested with
fakes (real bot can't run in the dev container — no mineflayer deps / no accounts).
It has **not** been run against real 2b2t accounts yet.

### What was built (this branch)

| File | Change |
|------|--------|
| `modules/network.js` | **NEW.** `BotNetwork` coordinator. `register`, `primary`, `isPrimary`, `findOwner(name)`, `allKnownPearls()`. Routes requests to the owning chamber; primary bot is the single responder for shared replies. |
| `modules/pearl-bot.js` | **NEW.** `PearlBot` class — encapsulates one bot's full lifecycle (createBot, spawn handling, bindModules, queue handler, login-mute walk, pre-spawn reconnect, intruder auto-disconnect). Extracted verbatim from the old single-bot `index.js`, tagged with `[name]` in logs. |
| `index.js` | **REWRITTEN** into a thin orchestrator: loads config, builds shared services (Logger, Whitelist, DiscordBot, ChatLogger, BotNetwork), builds one `PearlBot` per config entry, wires SIGINT/SIGTERM cleanup. `buildBotConfigs()` supports both the new `bots: [...]` shape **and** legacy `bot`+`stasis` (back-compat). |
| `modules/commands.js` | Added optional `options.{network, pearlBot}`. `!pearl <x>`: only the owning bot loads+replies; non-owners stay silent; primary emits the single "no pearl found". `!pearls`: primary replies with an aggregated cross-chamber list. `!recruit`: primary only. Single-bot mode (no network) behaves exactly as before. |
| `modules/discord.js` | Added `this.network`. `_processPearlRequest` routes via `network.findOwner()` when present, else falls back to the injected scanner/controller. |
| `modules/chat-logger.js` | Multi-bind: `bind`/`unbind` track a **set** of bots (was single `this.bot`). Added dedup (`_isDuplicate`, `dedup_window_ms` default 1500) so the same global-chat line seen by every bot is logged once. |
| `config.example.json` | Converted to the `bots: [...]` shape (two example chambers; chamber-2 has `recruiter.enabled:false`). |
| `.env.example` | Clarified: Microsoft bots auth via device code keyed by `username`; no per-bot email/password needed. |
| `README.md` | New "Bots & Chambers" config section + project-structure entries. |

### Tests run (in scratchpad, passed)
- **Routing** (`route-test.js`): Bob→only bot1 loads+replies; Carol→only bot2; Dave (nobody)→exactly one "not found" from primary; `!pearls`→one aggregated list; unauthorized user ignored.
- **Dedup** (`dedup-test.js`): 6 emitted (3 unique × 2 bots) → 3 DB rows, keyword flagging intact.

---

## ✅ DONE: integrated with `main` and merged (commit `dd188ae`)

Since the merge-base (`5fc95b5`), `main` had gained **3 commits this branch lacked**:
- `185aa8b` + `bf595cd` — **`modules/aura.js`** (attack nearby hostile mobs; 1.9+ cooldown-aware)
- `2653931` — **`modules/queue-monitor.js`** (live queue-position counter from the tab footer) + removed the dead chat-based parser from `queue.js`

Both were wired into the OLD single-bot `index.js`. This branch rewrote `index.js` into
the `PearlBot` architecture, so the merge conflicted on `index.js` and dropped that wiring
until it was re-added to `PearlBot`. **This has now been done** — the multi-bot work was
merged into `main` and pushed.

### How the conflicts were resolved (already applied on `main`)
- **`index.js`** → kept the thin orchestrator; added `aura: inherit(entry, 'aura')` to the
  per-bot config in `buildBotConfigs()`.
- **`config.example.json`** / **`README.md`** → git auto-merged cleanly (the `bots: [...]`
  shape plus `queue.queue_heartbeat_ms` / `queue.queue_stuck_timeout_ms` and the `aura`
  block all coexist; both doc sets preserved).
- **`modules/pearl-bot.js`** → re-wired both modules:
  - `QueueMonitor` — one instance per `PearlBot`, `attach()`ed pre-spawn in `createBot()`,
    `onSpawn()` in the spawn handler, `detach()` on pre-spawn disconnect, `stop()` in `stop()`.
  - `Aura` — per-bot module rebound in `bindModules()`; `start()` self-guards on
    `config.aura.enabled`; stopped in `bindModules()`/`stop()`.
  - Both log through a per-bot **tagged logger** (`_makeTaggedLogger()`) so two chambers'
    queue/aura output stays distinguishable in the shared log.
- Verified with `node -c` on every touched file + a scratchpad lifecycle test exercising
  `QueueMonitor.attach/onSpawn/detach/stop` and `Aura.start/tick/stop` against a fake bot.

---

## Remaining work (beyond integration)
- **User config migration:** their live `config.json` is single-bot (`bot`+`stasis`). Back-compat keeps it running, but to add the 2nd chamber they must switch to the `bots: [...]` shape (see README "Bots & Chambers"). Their `config.json` is gitignored — provide the migrated file directly; can't commit it.
- **First-run auth for the 2nd account:** each Microsoft bot prints a `microsoft.com/link` device code on first start, keyed by its `username`. They must sign into the 2nd account once (interactive) before it works headless on the server.
- **Real-account test:** verify both bots queue+spawn, each scans its own chamber, and a `!pearl <x>` in-game/Discord routes to the correct chamber with no double-replies.
- **Merge to `main` + push** once integrated & tested (server pulls `main`).

## Out of scope but open (separate thread)
- **Chat-signing investigation:** bot messages get dropped by 2b2t. Current setting is `disableChatSigning: true` (in `pearl-bot.js` `createBot`, preserved from old code). Leading hypothesis: 2b2t (native 1.21.4) enforces secure chat, so unsigned messages are dropped. Decisive check is already logged — look for `enforcesSecureChat:` and `[PKT-OUT] chat_message ... sig=NO` in `pearl-bot.log`. Not part of the multi-bot task.

## Conventions
- **Commit authorship = the user:** `GIT_AUTHOR_NAME="Jesus" GIT_AUTHOR_EMAIL="69329388+ejeebus@users.noreply.github.com"` (+ matching `GIT_COMMITTER_*`). No "claude" in branch names, commit messages, or any repo artifact.
