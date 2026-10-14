/**
 * Server-only passkey settings for the Biometrics layer (never VITE_). Read
 * lazily: an invalid value makes the Biometrics layer answer 503 (rule 5) and
 * never disables a check. Errors name the variable, never its value.
 */
import { GuardianError } from '../guardian.js';
import type { Surface } from './types.js';

export const LAYER_ENV = Object.freeze({ rpId: 'ANTARA_LAYER_RP_ID', origins: 'ANTARA_LAYER_ORIGINS' });
export const DESKTOP_ORIGIN = 'https://tauri.localhost';
export const EXTENSION_ORIGIN = 'chrome-extension://ckfkljfbjkmkjkkjkpbnmoehfipdcoin';
export const LAYER_DEFAULTS = Object.freeze({
  production: { rpId: 'antara.tech', origins: ['https://antara.tech', DESKTOP_ORIGIN, EXTENSION_ORIGIN] },
  development: { rpId: 'localhost', origins: ['http://localhost:1420', DESKTOP_ORIGIN, EXTENSION_ORIGIN] },
});

export interface LayerServerConfig {
  rpId: string;
  /** Exact origins accepted in clientDataJSON. */
  origins: string[];
  surfaceForOrigin(origin: string): Surface | null;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EXTENSION = /^chrome-extension:\/\/[a-p]{32}$/;
function validOrigin(origin: string, production: boolean): boolean {
  if (EXTENSION.test(origin)) return true;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin !== origin) return false;
  if (url.protocol === 'https:') return true;
  // Plain HTTP only for local development.
  return !production && url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}
/** desktop for the Tauri origin, extension for chrome-extension://, web for any other allowed origin. */
export function surfaceForOrigin(origin: string, origins: readonly string[]): Surface | null {
  if (!origins.includes(origin)) return null;
  if (origin === DESKTOP_ORIGIN) return 'desktop';
  if (EXTENSION.test(origin)) return 'extension';
  return 'web';
}

export function layerServerConfig(env: NodeJS.ProcessEnv = process.env): LayerServerConfig {
  const production = env.NODE_ENV === 'production';
  const defaults = production ? LAYER_DEFAULTS.production : LAYER_DEFAULTS.development;
  const rpId = env[LAYER_ENV.rpId]?.trim() || defaults.rpId;
  if (!DOMAIN.test(rpId) || /^\d+(\.\d+){3}$/.test(rpId)) {
    throw new GuardianError(`${LAYER_ENV.rpId} is not a valid domain, so passkeys cannot be checked. Nothing was approved or changed.`, 503, 'unavailable');
  }
  const configured = env[LAYER_ENV.origins]?.trim();
  const origins = configured ? configured.split(',').map(item => item.trim()).filter(Boolean) : [...defaults.origins];
  if (!origins.length || origins.length > 16 || !origins.every(origin => validOrigin(origin, production)) || new Set(origins).size !== origins.length) {
    throw new GuardianError(`${LAYER_ENV.origins} must be a comma-separated list of exact origins, so passkeys cannot be checked. Nothing was approved or changed.`, 503, 'unavailable');
  }
  return { rpId, origins, surfaceForOrigin: origin => surfaceForOrigin(origin, origins) };
}
