/** End-to-end encryption for Herald: key sets, signed envelopes, sealed files and keyring backups. */
export { b64u, E2eeError, type Bytes } from './bytes';
export { canon } from './canon';
export { H } from './hash';
export { fingerprint, keySet, safetyCode, type KeySet } from './keys';
export {
  envelopeDigest,
  grant,
  idempotencyDigest,
  MAX_PAYLOAD_BYTES,
  open,
  openKey,
  seal,
  type Ctx,
  type Expect,
  type Opener,
  type Payload,
  type RecipientKey,
  type Signer,
} from './envelope';
export {
  accountStatement,
  certify,
  createKeyring,
  keyringKeys,
  signReceiver,
  verifyAccount,
  verifyCertificate,
  verifyReceiver,
  type AccountInfo,
  type Keyring,
  type KeyringKeys,
  type ReceiverClaim,
} from './keyring';
export { fileKey, openFile, plaintextSize, sealedSize, sealFile, type FileSource } from './files';
export {
  parseRecoveryKey,
  prfSalt,
  recoveryKey,
  unwrapKeyring,
  wrapKeyring,
  type BackupSecret,
} from './backup';
export {
  approvalCode,
  approvalNonce,
  deviceCommit,
  openKeyring,
  sealKeyring,
  transferKey,
  type TransferKey,
} from './approval';
export { formatToken, parseToken, type ParsedToken } from './token';
export type {
  AccountKeys,
  Certificate,
  Recipient,
  SealedEnvelope,
  WrappedKeyring,
} from '../schema/e2ee';
