import { vi } from 'vitest';
import { sealedContracts } from './contracts';
import { Herald } from '../src/index';
/** A client with the contract fixtures' keyed token and its verified key directory loaded. */
export async function keyedClient(url = 'https://herald.test') {
  const herald = new Herald({ apiKey: sealedContracts.token, url });
  const keys = sealedContracts.steps.find((s) => s.name === 'keys')!.response.body;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(keys));
  await herald.keys();
  fetch.mockRestore();
  return herald;
}
