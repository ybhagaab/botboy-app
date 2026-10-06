/**
 * Slot for a Google OAuth Desktop client built into BotBoy. It ships EMPTY
 * (GMAIL_CHAT_TOOLS_PLAN.md decision D12): botboy-app is a public repository,
 * and Google's API terms say developer credentials may not be embedded in open
 * source projects. Every install saves its own client in Connections → Gmail
 * (the JSON file Google Cloud downloads, or the ID and secret), and that
 * client is the one BotBoy signs in with.
 *
 * Never commit values here. `gmail-connection.test.ts` fails when the slot is
 * not empty, and GitHub push protection rejects a release that carries a
 * Google client. An empty or half-filled slot means "no built-in client"
 * (gmail-credentials.ts › usableBuiltInClient).
 */
export const BOTBOY_GOOGLE_CLIENT: Readonly<{ clientId: string; clientSecret: string }> = Object.freeze({
  clientId: '',
  clientSecret: '',
});
