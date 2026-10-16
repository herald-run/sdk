import { afterEach, expect, it } from 'vitest';
import { hex } from './bytes';
import { deriveKeyPair, hpkeOpen, hpkeSeal } from './hpke';
import { setTestHooks } from './random';
afterEach(() => setTestHooks());
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
// RFC 9180 A.1.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode.
const rfc = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  ikmE: '7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234',
  pkEm: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  ikmR: '6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037',
  pkRm: '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d',
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  aad: '436f756e742d30',
  ct: 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a',
};
it('matches the RFC 9180 A.1.1 known-answer vector', async () => {
  const recipient = await deriveKeyPair(hex(rfc.ikmR));
  expect(toHex(recipient.pub)).toBe(rfc.pkRm);
  setTestHooks({ random: () => hex(rfc.ikmE) });
  const { enc, ct } = await hpkeSeal(recipient.pub, hex(rfc.info), hex(rfc.aad), hex(rfc.pt), 1);
  expect(toHex(enc)).toBe(rfc.pkEm);
  expect(toHex(ct)).toBe(rfc.ct);
  const pt = await hpkeOpen(recipient.priv, recipient.pub, enc, hex(rfc.info), hex(rfc.aad), ct, 1);
  expect(toHex(pt)).toBe(rfc.pt);
});
it('round trips the AES-256-GCM suite and rejects tampering', async () => {
  const recipient = await deriveKeyPair(hex(rfc.ikmR));
  const other = await deriveKeyPair(hex(rfc.ikmE));
  const { enc, ct } = await hpkeSeal(recipient.pub, hex(rfc.info), hex(rfc.aad), hex(rfc.pt));
  expect(ct.length).toBe(hex(rfc.pt).length + 16);
  const open = (c = ct, aad = rfc.aad, key = recipient) =>
    hpkeOpen(key.priv, key.pub, enc, hex(rfc.info), hex(aad), c);
  expect(toHex(await open())).toBe(rfc.pt);
  await expect(open(ct, '00')).rejects.toThrow('Decryption failed');
  await expect(open(Uint8Array.from(ct, (n, i) => (i ? n : n ^ 1)))).rejects.toThrow();
  await expect(open(ct, rfc.aad, other)).rejects.toThrow();
  await expect(
    hpkeOpen(recipient.priv, recipient.pub, new Uint8Array(32), hex(rfc.info), hex(rfc.aad), ct),
  ).rejects.toThrow('Invalid X25519');
});
