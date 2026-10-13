# SSE samples from Anthropic's streaming documentation

Fetched 2026-10-13 from https://platform.claude.com/docs/en/build-with-claude/streaming (source `.md` view):
`basic.sse` (Basic streaming request), `tool-use.sse` (Streaming request with tool use), `thinking.sse`
(Streaming request with thinking; it holds the multi-byte multiplication sign) and
`error-overloaded.sse` (Error events). Events are separated by blank lines as on the wire. Only
`anthropic-messages.test.ts` reads them (the stream reducer tests). The fake server (`anthropic-api.fake.ts`)
builds its own streams and does not read this folder; `tsc` never imports it.
They are public documentation samples and hold no credential.
