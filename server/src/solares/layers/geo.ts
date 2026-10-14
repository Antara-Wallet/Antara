/**
 * The Safe Zones layer's check. The reading is device-reported: a modified
 * device or location spoofing can fake it. A reading passes only when its own
 * uncertainty fits well inside a safe zone, so an imprecise fix never
 * counts as "inside" (missing, zero or non-finite accuracy denies).
 */
import { RADIUS_BOUNDS_M, type SafeZoneRecord } from './types.js';

/** Mean Earth radius (IUGG), metres. */
const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => degrees * Math.PI / 180;

/** Great-circle distance in metres; NaN for any non-finite input. */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return NaN;
  const dLat = radians(b.lat - a.lat), dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const validLatLng = (lat: unknown, lng: unknown): boolean =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
export const validRadius = (radiusM: unknown): radiusM is number =>
  typeof radiusM === 'number' && Number.isInteger(radiusM) && radiusM >= RADIUS_BOUNDS_M.min && radiusM <= RADIUS_BOUNDS_M.max;
/** Accuracy must be a finite, strictly positive radius in metres. 0 means "unknown" on some platforms, so it denies. */
export const validAccuracy = (accuracyM: unknown): accuracyM is number => typeof accuracyM === 'number' && Number.isFinite(accuracyM) && accuracyM > 0;

export type ZoneCheck = { ok: true } | { ok: false; reason: string };
/**
 * Passes only if some zone has accuracyM <= radiusM / 2 and
 * haversine(center, reading) + accuracyM <= radiusM. The reason never reveals
 * a zone's center or the distance to it.
 */
export function zoneCheck(reading: { lat: unknown; lng: unknown; accuracyM: unknown } | null | undefined, zones: readonly SafeZoneRecord[]): ZoneCheck {
  if (!reading) return { ok: false, reason: 'No location reading was sent.' };
  if (!validLatLng(reading.lat, reading.lng)) return { ok: false, reason: 'The location reading is invalid.' };
  if (!validAccuracy(reading.accuracyM)) return { ok: false, reason: 'The location reading has no usable accuracy.' };
  const point = { lat: reading.lat as number, lng: reading.lng as number }, accuracy = reading.accuracyM;
  let preciseEnough = false;
  for (const zone of zones) {
    if (!validLatLng(zone.lat, zone.lng) || !validRadius(zone.radiusM)) continue;
    if (accuracy > zone.radiusM / 2) continue;
    preciseEnough = true;
    const distance = haversineM(zone, point);
    if (Number.isFinite(distance) && distance + accuracy <= zone.radiusM) return { ok: true };
  }
  return { ok: false, reason: preciseEnough ? 'Your reported location is outside your safe zones.' : 'Your location reading is not accurate enough for your safe zones.' };
}
