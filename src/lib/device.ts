/**
 * Is this a phone/tablet (a device with a built-in Face ID / fingerprint
 * platform authenticator)? Desktops do not have Face ID, so the enroll/approve
 * pages show a QR to bounce to the phone instead of trying the OS passkey dialog.
 */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  // iPadOS Safari reports as "Macintosh" — detect it by touch support.
  if (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1) {
    return true;
  }
  return false;
}
