/**
 * The Wi-Fi layer's server-observed part: the public IP ANTARA's server sees
 * (clientIp(req): the edge's CF-Connecting-IP on Render, otherwise req.ip behind
 * exactly TRUST_PROXY hops) must lie in an enrolled prefix.
 * Anyone on the same network, or a VPN that exits there, shares that address.
 */
import { BlockList, isIP } from 'node:net';
import { PREFIX_BOUNDS } from './types.js';

export interface ParsedIp { family: 4 | 6; bytes: Uint8Array }

function parseIpv4(text: string): Uint8Array | null {
  if (isIP(text) !== 4) return null;
  const parts = text.split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? Uint8Array.from(parts) : null;
}
function parseIpv6(text: string): Uint8Array | null {
  if (isIP(text) !== 6 || text.includes('%')) return null;
  let head = text, tail = '';
  const double = text.indexOf('::');
  if (double >= 0) { head = text.slice(0, double); tail = text.slice(double + 2); }
  const groups = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index];
      if (index === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) out.push(parseInt(piece, 16));
      else return null;
    }
    return out;
  };
  const left = groups(head), right = groups(tail);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (double >= 0 ? missing < 1 : missing !== 0) return null;
  const all = [...left, ...Array<number>(double >= 0 ? missing : 0).fill(0), ...right];
  const bytes = new Uint8Array(16);
  all.forEach((group, index) => { bytes[index * 2] = group >> 8; bytes[index * 2 + 1] = group & 0xff; });
  return bytes;
}
/** Parses an IP address; IPv4-mapped IPv6 (::ffff:a.b.c.d) is normalised to IPv4. Zone ids are refused. */
export function parseIp(value: unknown): ParsedIp | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const v4 = parseIpv4(value);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = parseIpv6(value);
  if (!v6) return null;
  if (v6.subarray(0, 10).every(byte => byte === 0) && v6[10] === 0xff && v6[11] === 0xff) return { family: 4, bytes: v6.slice(12) };
  return { family: 6, bytes: v6 };
}
/** Dotted IPv4, or RFC 5952 IPv6 (lowercase, longest zero run compressed). */
export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) return Array.from(ip.bytes).join('.');
  const groups = Array.from({ length: 8 }, (_, index) => (ip.bytes[index * 2] << 8) | ip.bytes[index * 2 + 1]);
  let bestStart = -1, bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) { index++; continue; }
    let end = index;
    while (end < 8 && groups[end] === 0) end++;
    if (end - index > bestLength && end - index >= 2) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const hex = groups.map(group => group.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}
function inPrefix(bytes: Uint8Array, prefix: readonly number[], length: number): boolean {
  for (let bit = 0; bit < length; bit++) {
    const byte = bit >> 3, mask = 0x80 >> (bit & 7);
    if ((bytes[byte] & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}
// Never a client's public address: unspecified, private, CGNAT, loopback, link-local, multicast and reserved.
const NOT_PUBLIC_V4: Array<[number[], number]> = [
  [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12], [[192, 168], 16], [[224], 4], [[240], 4],
];
// Unspecified, loopback, IPv4-compatible, unique local (ULA), link-local, site-local and multicast.
const NOT_PUBLIC_V6: Array<[number[], number]> = [
  [[], 128], [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128], [[], 96], [[0xfc], 7], [[0xfe, 0x80], 10], [[0xfe, 0xc0], 10], [[0xff], 8],
];
export function isPublicIp(ip: ParsedIp): boolean {
  return !(ip.family === 4 ? NOT_PUBLIC_V4 : NOT_PUBLIC_V6).some(([prefix, length]) => inPrefix(ip.bytes, prefix, length));
}
function masked(ip: ParsedIp, prefixLength: number): ParsedIp {
  const bytes = ip.bytes.slice();
  for (let bit = prefixLength; bit < bytes.length * 8; bit++) bytes[bit >> 3] &= ~(0x80 >> (bit & 7));
  return { family: ip.family, bytes };
}
const bounds = (family: 4 | 6) => family === 4 ? PREFIX_BOUNDS.ipv4 : PREFIX_BOUNDS.ipv6;

/**
 * The enrolled form of a network: the masked network address and its prefix.
 * IPv4 /24../32 (default /32), IPv6 /48../128 (default /64). A prefix that
 * covers a private, loopback, link-local, CGNAT or ULA range is refused.
 */
export function cidrFor(ip: ParsedIp, prefixLength?: number): string | null {
  const limits = bounds(ip.family);
  const length = prefixLength ?? limits.default;
  if (!Number.isInteger(length) || length < limits.min || length > limits.max) return null;
  const network = masked(ip, length);
  if (!isPublicIp(network) || !isPublicIp(ip)) return null;
  return `${formatIp(network)}/${length}`;
}
/** Canonical CIDR text, or null for anything malformed, out of bounds or not public. A bare address takes the default prefix. */
export function normaliseCidr(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const [address, prefix, extra] = value.trim().split('/');
  if (extra !== undefined) return null;
  const ip = parseIp(address);
  if (!ip || (ip.family === 4 && address.includes(':'))) return null;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return null;
  return cidrFor(ip, prefix === undefined ? undefined : Number(prefix));
}
/** True when `ip` lies in the canonical `cidr` (node:net BlockList). */
export function cidrContains(cidr: string, ip: ParsedIp): boolean {
  const [address, prefix] = cidr.split('/');
  const network = parseIp(address);
  if (!network || network.family !== ip.family || !/^\d{1,3}$/.test(prefix ?? '')) return false;
  const list = new BlockList();
  const family = ip.family === 4 ? 'ipv4' : 'ipv6';
  list.addSubnet(formatIp(network), Number(prefix), family);
  return list.check(formatIp(ip), family);
}
/** Display form that never reveals the full address: "IPv4 81.2.x.x/32", "IPv6 2a01:4f8:c0c:…/64". */
export function maskCidr(cidr: string): string {
  const [address, prefix] = cidr.split('/');
  const ip = parseIp(address);
  if (!ip) return 'Network';
  if (ip.family === 4) return `IPv4 ${ip.bytes[0]}.${ip.bytes[1]}.x.x/${prefix}`;
  const groups = Array.from({ length: 3 }, (_, index) => ((ip.bytes[index * 2] << 8) | ip.bytes[index * 2 + 1]).toString(16));
  return `IPv6 ${groups.join(':')}:…/${prefix}`;
}

export type NetworkObservation =
  | { status: 'public'; ip: ParsedIp }
  /** Production with TRUST_PROXY=false and no edge header: the address is the load balancer, so no client address can be observed. */
  | { status: 'unconfigured' }
  | { status: 'not-public' };
/** clientIpHeader: the edge header clientIp.ts reads (config CLIENT_IP_HEADER); when set, TRUST_PROXY does not decide observability. */
export interface NetworkSettings { production: boolean; trustProxy: number | false; clientIpHeader?: string | null }
/** The public client address the server observes for this request, normalised; never trusted from the request body. */
export function observeNetwork(requestIp: string | null | undefined, settings: NetworkSettings): NetworkObservation {
  if (settings.production && settings.trustProxy === false && !settings.clientIpHeader) return { status: 'unconfigured' };
  const ip = parseIp(requestIp);
  return ip && isPublicIp(ip) ? { status: 'public', ip } : { status: 'not-public' };
}
export function sameIp(a: ParsedIp, b: ParsedIp): boolean {
  return a.family === b.family && a.bytes.length === b.bytes.length && a.bytes.every((byte, index) => byte === b.bytes[index]);
}
