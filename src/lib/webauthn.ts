import {
  webauthnPhoneStart,
  webauthnPhoneApproveStart,
  webauthnPhonePoll,
  type SwapChain,
} from "./api";
import { phoneEnrollStore, type PhonePrompt } from "./phoneEnroll";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Client side of the "Face ID" layer. Both enrollment AND approval run through
 * our OWN in-app QR: the desktop shows a QR (rendered by <PhoneEnrollModal>)
 * pointing at the useark.app page; the user scans it and does Face ID on their
 * phone; we poll until it lands. No OS passkey dialog involved.
 */
export const WEBAUTHN_NATIVE_READY = true;

export class WebauthnUnavailable extends Error {
  constructor() {
    super("Face ID isn't available right now.");
    this.name = "WebauthnUnavailable";
  }
}

/**
 * Drive the in-app QR modal for a phone session: show it, poll until the phone
 * completes, and return whatever the session relayed back (an assertion for
 * approvals; nothing for enrollment). Throws on cancel / expiry / failure.
 */
async function runPhoneFlow(
  token: string,
  prompt: PhonePrompt,
  noun: string
): Promise<unknown> {
  let cancelled = false;
  phoneEnrollStore.show(prompt, () => {
    cancelled = true;
  });
  try {
    const deadline = Date.now() + 10 * 60_000;
    while (!cancelled && Date.now() < deadline) {
      await sleep(1600);
      let status: string;
      let result: unknown;
      try {
        ({ status, result } = await webauthnPhonePoll(token));
      } catch {
        continue; // transient network blip; keep polling
      }
      if (status === "done") return result;
      if (status === "error") throw new Error(`Face ID ${noun} failed. Please try again.`);
      if (status === "expired") throw new Error(`The ${noun} QR expired. Please try again.`);
    }
    if (cancelled) throw new Error(`Face ID ${noun} cancelled.`);
    throw new Error(`Face ID ${noun} timed out.`);
  } finally {
    phoneEnrollStore.hide();
  }
}

/** Enroll a passkey for a vault (when the Face ID layer is switched on). */
export async function enrollPasskey(
  chain: SwapChain,
  safeAddress: `0x${string}`
): Promise<void> {
  const { token, url } = await webauthnPhoneStart(chain, safeAddress);
  await runPhoneFlow(
    token,
    {
      url,
      title: "Activate Face ID",
      subtitle: "Scan with your phone, then confirm with Face ID or your fingerprint.",
    },
    "enrollment"
  );
}

/**
 * Approve a specific transfer with Face ID, via the in-app QR. Returns the signed
 * assertion to hand to the co-signer, which verifies it against the enrolled
 * passkey and this exact transaction before it signs.
 */
export async function approveWithPasskey(
  chain: SwapChain,
  safeAddress: `0x${string}`,
  safeTxHash: string // tx hash, or an intent like "policy-update"
): Promise<unknown> {
  const { token, url } = await webauthnPhoneApproveStart(chain, safeAddress, safeTxHash);
  const result = await runPhoneFlow(
    token,
    {
      url,
      title: "Approve with Face ID",
      subtitle: "Scan with your phone to approve this transfer with Face ID or your fingerprint.",
    },
    "approval"
  );
  if (result == null) throw new Error("No approval was returned from your phone.");
  return result;
}
