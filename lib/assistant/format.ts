const KEYCAP = /([0-9#*])️?⃣/gu;
// One pictographic emoji, with its variation selector, skin tone and ZWJ parts.
const EMOJI = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})*)*/gu;

/**
 * Final clean-up of an assistant DM, same rules as the WhatsApp agent: at most
 * one emoji, keycap numbers as plain "1.", no Markdown bold or tables.
 */
export function cleanAssistantText(text: string, maxEmojis = 1): string {
  let seen = 0;
  return text
    .replace(KEYCAP, "$1.")
    .replace(EMOJI, (emoji) => (++seen <= maxEmojis ? emoji : ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}.*$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
