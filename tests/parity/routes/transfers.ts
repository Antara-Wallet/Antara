/**
 * Area B route module (docs/UI_ARGUS_PARITY.md 10.2), only if Send's review needs
 * RPC answers beyond the base fake: register them with `ctx.rpc.solana(...)` or
 * `ctx.rpc.evm(...)`. Stub created by Area A so the runner imports it statically;
 * Area B owns and fills it.
 */
import type { RouteInstaller } from '../types';

export const install: RouteInstaller = async () => {};
