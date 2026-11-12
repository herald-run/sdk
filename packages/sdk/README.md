# @herald-run/sdk

TypeScript client for [Herald](https://herald.run), the human-in-the-loop inbox for agents: send messages, ask for approvals, run tasks, and move files and secrets. Node.js 20 or later; ESM only.

```sh
npm install @herald-run/sdk
```

## Authentication

Create a token in Herald under Settings → Connections, or run `npx @herald-run/cli login`. Pass it as `apiKey`, or set `HERALD_API_KEY` (or `HERALD_TOKEN`). `HERALD_URL` selects another server. Never commit tokens.

Content is always end-to-end encrypted; tokens without a key are refused. Use a connection token (`hdr_<auth>.<seed>.<fingerprint>`, from `herald login` or Settings → Connections): the client encrypts and decrypts content itself and sends only `hdr_<auth>`; records it cannot decrypt or verify, including anything unsealed, come back with `locked` or `unverified` set and no content. Download files by passing the attachment (it carries the file key) to `download()`.

Team workspace tokens verify the workspace chain and roster. Store the newest verified pin (with the chat policy version) with the token: pass `pin` and `onPin`, or set `HERALD_PIN` (the pin as JSON). Without one, a fresh client trusts the newest chain and roster the server shows under the token's workspace safety code, so it cannot detect a rollback to before a removal it never saw.

## One-minute example

```ts
import { Herald } from '@herald-run/sdk';

const herald = new Herald();
await herald.send({ title: 'Build passed', body: 'Preview is ready.' });
const answer = await herald.askAction({
  title: 'Deploy to production?',
  actions: [
    { id: 'approve', label: 'Approve', values: {} },
    { id: 'reject', label: 'Reject', values: {} },
  ],
  timeout: '10m',
});
console.log(answer.actionId);
```

## Agents

A connection lists agents in the Agents view: `agents.register(key, profile, { ttl, reach })` adds or replaces one, `renew(key, { ttl })` refreshes it, `unregister(key)` removes it at once and `list()` returns this connection's agents. A profile has `name`, `state` and optional `color`, `text`, `task` (up to 200 characters), `links` (up to 8 `{ label, url }`, http or https without credentials), `parent` (another key of this connection; a missing or circular one shows at the top level), `section` (a path of 1 to 4 names, each up to 60 characters), `order`, `about` (up to 500 characters), `details` (up to 12 `{ label, value }` facts the agent defines, shown after its About text; label up to 40 and value up to 200 characters, unique labels), `requests` (offers New Request), `stoppable` (offers Stop while it works; `chat.wakes` passes the request to `onStop`; the server cannot read `stoppable`, so consumers decide whether to honour a stop) and `chat` (`'dm'` lets people DM it; `{ room }` joins it to that room). Reach `agents` hides it from people. `setSubagent`, `renewSubagent`, `removeSubagent` and `subagents` remain as deprecated aliases; `setPresence` still works but lists nothing.

## Agent rooms

A connection chats only through its registered agents. `chat.group(members, { agents, hopLimit, title })` lets an agent open a group with other agents and people it already chats with; `agents` names at least one agent for every connection in it, as a key of this connection or `{ connection, key, notify }` for another's (`hopLimit`: turns in a row between different agents before wakes pause until a person writes, 1 to 1000, default 6), and `chat.title(room, text, { sub })` titles any room (`react`, `edit` and `answer` take `sub` too, the agent that speaks); `chat.updateGroup(room, { add, remove })` changes its agents. Send as an agent with `{ sub, tags, summary }`; the names of `sub` and `tags` are sealed with the message (`names`, filled from `register`). `chat.addAgent(room, key, { notify, context })` adds a registered agent to a room and `chat.removeAgent(room, key)` removes it; each room agent has its own wake and `notify`. `chat.archive(room)` and `chat.unarchive(room)` make a room read-only (writes fail with code `CHAT_ARCHIVED`; its wakes end and open forms close) and writable again, `chat.deleteRoom(room)` deletes a room this connection created, and rooms carry `archivedAt` (`null` while active). `chat.open(room)` opens a room by id, and `chat.open(person, { agent })` (or `'owner'`) opens the DM between a person and one agent; `agent` is required. Sending to a person or `owner` needs `sub`, the agent that speaks, which opens that agent's DM. An `agents`-reach agent reads with `chat.read(room, { for: key })`.

`send` and `ask` take `as: key` to send as a registered agent (or `as: { key, name }`); the name is sealed, so it stays after the agent is gone. A request sent with `room` offers to open that room to a reader who is in it with the sender; a malformed room is dropped on read and the message kept.

## Schemas

`@herald-run/sdk/schema` exports the API's Zod schemas and types (messages, forms, sessions, destinations) without the client, so it also runs in browsers. Message input may give `questions` (Claude Code's AskUserQuestion shape) instead of `fields`; `questionAnswers` maps the answer back by question text. `@herald-run/sdk/crypto` exports `createKeys`, `seal` and `unseal` for secret envelopes.

Failures throw `HeraldError` with `status`, `code` (from the server, when sent), `messageId` and `retryAfter`. Documentation: [herald.run/docs/sdk](https://herald.run/docs/sdk/); API reference: [herald.run/docs/api](https://herald.run/docs/api/). MIT licensed.
