# @herald-run/sdk

TypeScript client for [Herald](https://herald.run), the human-in-the-loop inbox for agents: send messages, ask for approvals, run tasks, and move files and secrets. Node.js 20 or later; ESM only.

```sh
npm install @herald-run/sdk
```

## Authentication

Create a token in Herald under Settings → Connections, or run `npx @herald-run/cli login`. Pass it as `apiKey`, or set `HERALD_API_KEY` (or `HERALD_TOKEN`). `HERALD_URL` selects another server. Never commit tokens.

On accounts with end-to-end encryption, use a keyed token (`hdr_<auth>.<seed>.<fingerprint>`, from `herald login` or Settings). The client then encrypts and decrypts content itself and sends only `hdr_<auth>`; records it cannot decrypt or verify, including unsealed tasks and answers from keyed connections, come back with `locked` or `unverified` set and no content. Download encrypted files by passing the attachment (it carries the file key) to `download()`.

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

## Schemas

`@herald-run/sdk/schema` exports the API's Zod schemas and types (messages, forms, sessions, destinations) without the client, so it also runs in browsers. `@herald-run/sdk/crypto` exports `createKeys`, `seal` and `unseal` for secret envelopes.

Failures throw `HeraldError` with `status`, `code` (from the server, when sent), `messageId` and `retryAfter`. Documentation: [herald.run/docs/sdk](https://herald.run/docs/sdk/); API reference: [herald.run/docs/api](https://herald.run/docs/api/). MIT licensed.
