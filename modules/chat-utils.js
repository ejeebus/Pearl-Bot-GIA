/**
 * Shared chat-message parsing helpers used by CommandHandler and ChatLogger.
 */

/**
 * Try to extract a chat message's sender username from Mineflayer's
 * messagestr/jsonMsg payload. Handles public chat, 1.19+ whispers, and
 * pre-1.19 whispers. Falls back to plain-text pattern matching.
 *
 * @param {string} msg - Plain text of the message
 * @param {object} jsonMsg - Mineflayer ChatMessage object (or similar)
 * @returns {string|null}
 */
function extractSender(msg, jsonMsg) {
  try {
    if (jsonMsg?.json?.translate === "chat.type.text") {
      const withData = jsonMsg.json.with;
      if (Array.isArray(withData)) {
        // Pre-1.19:  ["PlayerName", " message text"]
        if (withData.length >= 2 && withData[0]?.text) {
          return withData[0].text;
        }
        // 1.19+: ["<PlayerName> message text"]
        if (withData.length === 1) {
          const content =
            typeof withData[0] === "object"
              ? withData[0].text
              : String(withData[0]);
          const match = content.match(/^<([^>]+?)>\s/);
          if (match) return match[1];
        }
      }
    }

    // Whisper (1.19+): translate key "commands.message.display.incoming"
    if (jsonMsg?.json?.translate === "commands.message.display.incoming") {
      const withData = jsonMsg.json.with;
      if (Array.isArray(withData) && withData.length >= 1) {
        const s = withData[0];
        const name = typeof s === "string" ? s : (s?.text ?? s?.insertion);
        if (name) return name;
      }
    }
  } catch {
    // jsonMsg structure may vary — fall through to text parsing
  }

  if (typeof msg === "string") {
    // Public chat fallback: <PlayerName> message
    const pubMatch = msg.match(/^<([^>]+?)>\s/);
    if (pubMatch) return pubMatch[1];

    // Whisper fallback: "PlayerName whispers: message" or "PlayerName whispers to you: message"
    const whisperMatch = msg.match(/^([a-zA-Z0-9_]{1,16}) whispers(?: to you)?:/);
    if (whisperMatch) return whisperMatch[1];
  }

  return null;
}

/**
 * Strip the leading "<Name> " or "Name whispers: " prefix from a chat line,
 * leaving just the message body. Returns the original string if no prefix matches.
 */
function stripSenderPrefix(msg) {
  if (typeof msg !== "string") return msg;
  return msg
    .replace(/^<[^>]+?>\s*/, "")
    .replace(/^[a-zA-Z0-9_]{1,16} whispers(?: to you)?:\s*/, "");
}

module.exports = { extractSender, stripSenderPrefix };
