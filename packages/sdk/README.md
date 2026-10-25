# @herald-run/sdk

TypeScript client for [Herald](https://herald.run), the human-in-the-loop inbox for agents: send messages, ask for approvals, run tasks, and move files and secrets. Node.js 20 or later; ESM only.

```sh
npm install @herald-run/sdk
```

## Authentication

Create a token in Herald under Settings → Connections, or run `npx @herald-run/cli login`. Pass it as `apiKey`, or set `HERALD_API_KEY` (or `HERALD_TOKEN`). `HERALD_URL` selects another server. Never commit tokens.

Content is always end-to-end encrypted; tokens without a key are refused. Use a connection token (`hdr_<auth>.<seed>.<fingerprint>`, from `herald login` or Settings → Connections): the client encrypts and decrypts content itself and sends only `hdr_<auth>`; records it cannot decrypt or verify, including anything unsealed, come back with `locked` or `unverified` set and no content. Download files by passing the attachment (it carries the file key) to `download()`.

Team workspace tokens verify the workspace chain and roster. Store the newest verified pin with the token: pass `pin` and `onPin`, or set `HERALD_PIN` (the pin as JSON). Without one, a fresh client trusts the newest chain and roster the server shows under the token's workspace safety code, so it cannot detect a rollback to before a removal it never saw.

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

## Fleet

`herald.fleet` reports what agents work on to Herald's Fleet view (needs `fleet:write`). Unit states are end-to-end encrypted.

```ts
const world = await herald.fleet.world('acme/app');
await herald.fleet.report(world!.id, [
  { key: 'ci-42', state: { name: 'CI', kind: 'ci', activity: 'running', ref: 'main' } },
]);
const reporter = herald.fleet.reporter(world!.id, {
  onError: (e) => console.error(e.error),
  // A viewer joined: re-send live state.
  onSync: () => void reporter.send([ci], { persist: false }),
});
const ci = { key: 'ci-42', state: { name: 'CI', activity: 'done' as const } };
await reporter.send([ci], { persist: true });
```

HTTP writes each unit at most every 10 s; the reporter socket allows more frequent updates (`persist: false` only reaches live viewers). Orchestrators running many agents report them all on one reporter: store on structural changes, send activity live, and answer `onSync` by re-sending live state. States may carry `squad` (a label) and `parent` (an orchestrator's unit key). Also `worlds()`, `remove()` and `track()`.

## Schemas

`@herald-run/sdk/schema` exports the API's Zod schemas and types (messages, forms, sessions, destinations) without the client, so it also runs in browsers. Message input may give `questions` (Claude Code's AskUserQuestion shape) instead of `fields`; `questionAnswers` maps the answer back by question text. `@herald-run/sdk/crypto` exports `createKeys`, `seal` and `unseal` for secret envelopes.

Failures throw `HeraldError` with `status`, `code` (from the server, when sent), `messageId`, `retryAfter` and `resetsAt` (a paused Fleet quota). Documentation: [herald.run/docs/sdk](https://herald.run/docs/sdk/); API reference: [herald.run/docs/api](https://herald.run/docs/api/). MIT licensed.
