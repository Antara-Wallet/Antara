/**
 * Vault layer routes under /api/solares/paired-vault (docs/VAULT_LAYERS.md section 9).
 * Every answer goes through the strict parsers in schema.ts.
 */
import { call } from '../vaults/pairedApi';
import { LayerViewError, parseCancelResult, parseChangeChallenge, parseChangeResult, parsePendingNotices, parseReleaseChallenge, parseVaultLayers } from './schema';
import {
  MAX_EVIDENCE_BYTES, isEnrollOp,
  type AuthenticationResponseJSON, type ChangeOp, type OptionalLayerId, type RegistrationResponseJSON, type SignedDevicePayload,
} from './types';

export {
  LayerViewError, parseCancelResult, parseChangeChallenge, parseChangeResult, parseCreationOptions, parseLayerRequirements, parseLayerResults,
  parsePendingNotices, parseReleaseChallenge, parseRequestOptions, parseVaultLayers, looksUnmasked,
} from './schema';

/** The server refuses evidence over 16 KB; refuse it here first so nothing partial is sent. */
function assertEvidenceSize(evidence: unknown) {
  if (new TextEncoder().encode(JSON.stringify(evidence)).length > MAX_EVIDENCE_BYTES) throw new Error('The verification is too large to send. Nothing was changed.');
}

/**
 * GET /solana/layers. A 200 the strict parser refuses shows no layer status, but any pending change it
 * still names is kept (LayerViewError.pending), so a pending weakening can always be seen and cancelled.
 */
export const fetchVaultLayers = (token: string, multisig: string, signal?: AbortSignal) =>
  call(`/solana/layers?multisig=${encodeURIComponent(multisig)}`, token, value => {
    try { return parseVaultLayers(value, multisig); }
    catch (failure) { throw new LayerViewError(failure instanceof Error ? failure.message : 'The vault service returned an unexpected layer response.', parsePendingNotices(value, multisig) ?? []); }
  }, { signal });

export const beginLayerApproval = (token: string, multisig: string, transactionIndex: string) =>
  call('/solana/layers/approval/begin', token, value => parseReleaseChallenge(value, multisig, transactionIndex), { body: { multisig, transactionIndex } });

export const beginEnroll = (token: string, multisig: string, op: ChangeOp, waive: OptionalLayerId[] = []) => {
  if (!isEnrollOp(op)) throw new Error('This change is not an addition.');
  return call('/solana/layers/enroll/begin', token, value => parseChangeChallenge(value, 'enroll'), { body: waive.length ? { multisig, op, waive } : { multisig, op } });
};

export const beginChange = (token: string, multisig: string, op: ChangeOp, waive: OptionalLayerId[] = []) => {
  if (isEnrollOp(op)) throw new Error('Additions use enrollment.');
  return call('/solana/layers/change/begin', token, value => parseChangeChallenge(value, 'change'), { body: waive.length ? { multisig, op, waive } : { multisig, op } });
};

export interface ChangeEvidence { registration?: RegistrationResponseJSON; passkey?: AuthenticationResponseJSON; device?: SignedDevicePayload; totp?: { code: string } }

export function finishEnroll(token: string, multisig: string, challengeId: string, evidence: ChangeEvidence) {
  const body = { multisig, challengeId, ...evidence };
  assertEvidenceSize(evidence);
  return call('/solana/layers/enroll/finish', token, parseChangeResult, { body });
}

export function finishChange(token: string, multisig: string, challengeId: string, evidence: Omit<ChangeEvidence, 'registration'>) {
  const body = { multisig, challengeId, ...(evidence.passkey ? { passkey: evidence.passkey } : {}), ...(evidence.device ? { device: evidence.device } : {}), ...(evidence.totp ? { totp: evidence.totp } : {}) };
  assertEvidenceSize(evidence);
  return call('/solana/layers/change/finish', token, parseChangeResult, { body });
}

export const cancelChange = (token: string, multisig: string, changeId: string) =>
  call('/solana/layers/change/cancel', token, parseCancelResult, { body: { multisig, changeId } });

export { assertEvidenceSize };
