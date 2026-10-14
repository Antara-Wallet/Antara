import { useEffect, useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { QRCodeSVG } from "qrcode.react";
import { API_BASE } from "../lib/api";
import { isMobileDevice } from "../lib/device";
import mobileBg from "../assets/landing/mobile.png";

/**
 * Approval page (served at useark.app/approve?s=<token>).
 *
 * On a PHONE it runs Face ID / fingerprint against the passkey enrolled for the
 * vault and posts the signed assertion to the session the agent/desktop polls.
 *
 * On a DESKTOP there is no Face ID, so it shows a QR pointing at this same URL;
 * the user scans it with their phone and approves there. This page polls the
 * session and flips to "done" once the phone approves.
 */
export function Approve() {
  const token = new URLSearchParams(window.location.search).get("s");
  const mobile = isMobileDevice();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState("");

  // Desktop: watch the session so this page reflects the phone approving.
  useEffect(() => {
    if (mobile || !token || state === "done") return;
    let live = true;
    const id = window.setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/vault/webauthn/phone/poll/${token}`);
        const j = await r.json();
        if (live && j.status === "done") setState("done");
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [mobile, token, state]);

  async function run() {
    if (!token) {
      setState("error");
      setError("This link is invalid. Start again from the ANTARA app.");
      return;
    }
    setState("working");
    setError("");
    try {
      const optRes = await fetch(`${API_BASE}/vault/webauthn/phone/options/${token}`);
      if (!optRes.ok) throw new Error("This request has expired. Start again from the ANTARA app.");
      const optionsJSON = await optRes.json();

      const assertion = await startAuthentication({ optionsJSON });

      const verRes = await fetch(`${API_BASE}/vault/webauthn/phone/verify/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: assertion }),
      });
      const verJson = await verRes.json().catch(() => ({}));
      if (!verRes.ok || verJson.ok === false) {
        throw new Error(verJson.error || "Could not confirm. Please try again.");
      }
      setState("done");
    } catch (e) {
      setState("error");
      const msg = e instanceof Error ? e.message : String(e);
      setError(/NotAllowed|aborted|cancel/i.test(msg) ? "Face ID was cancelled." : msg);
    }
  }

  return (
    <div
      className="ark-enroll"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(6,5,3,0.5), rgba(6,5,3,0.82)), url(${mobileBg})`,
      }}
    >
      <div className="ark-enroll-card">
        {state === "done" ? (
          <>
            <div className="ark-enroll-check">✓</div>
            <h1>Transfer approved</h1>
            <p>Return to the ANTARA app or your agent. It is already finishing the transfer.</p>
          </>
        ) : !mobile ? (
          <>
            <h1>Approve transfer</h1>
            <p>
              Scan this with your phone’s camera to approve this transfer from your ANTARA vault
              with Face ID.
            </p>
            <div className="ark-enroll-qr">
              <QRCodeSVG value={window.location.href} size={208} bgColor="#ffffff" fgColor="#0a0a0b" marginSize={2} />
            </div>
            <div className="ark-enroll-wait">
              <span className="ark-enroll-dot" /> Waiting for your phone…
            </div>
            <button type="button" className="ark-enroll-link" onClick={run}>
              Use Face ID or Windows Hello on this computer instead
            </button>
            <p className="ark-enroll-foot">ark · useark.app</p>
          </>
        ) : (
          <>
            <h1>Approve transfer</h1>
            <p>
              Confirm with your phone’s Face ID or fingerprint to authorize this transfer from
              your ANTARA vault.
            </p>
            {state === "error" && <p className="ark-enroll-error">{error}</p>}
            <button
              type="button"
              className="ark-enroll-btn"
              disabled={state === "working"}
              onClick={run}
            >
              {state === "working" ? "Waiting for Face ID…" : "Approve with Face ID"}
            </button>
            <p className="ark-enroll-foot">ark · useark.app</p>
          </>
        )}
      </div>
    </div>
  );
}
