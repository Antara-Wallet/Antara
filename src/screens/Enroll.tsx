import { useEffect, useState, type FormEvent } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { QRCodeSVG } from "qrcode.react";
import { API_BASE } from "../lib/api";
import { isMobileDevice } from "../lib/device";
import castleBg from "../assets/landing/mobile.png";

/**
 * Enrollment page (served at useark.app/enroll?s=<token>).
 *
 * On a PHONE it runs Face ID / fingerprint natively (the passkey is created on
 * the phone, bound to useark.app) and posts the result to the session.
 *
 * On a DESKTOP there is no Face ID, so instead of triggering the OS passkey
 * dialog it shows a QR pointing at this same URL; the user scans it with their
 * phone and finishes there. This page then polls the session and flips to "done"
 * once the phone completes.
 */
function CodeEntry() {
  const initial = (new URLSearchParams(window.location.search).get("c") || "").toUpperCase();
  const [code, setCode] = useState(initial);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(!!initial);
  async function resolveCode(c: string) {
    if (c.length < 4) {
      setErr("Enter the code your agent gave you.");
      setBusy(false);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`${API_BASE}/vault/webauthn/phone/resolve/${encodeURIComponent(c)}`);
      if (!r.ok) throw new Error("That code wasn't found or has expired. Ask your agent for a new one.");
      const j = (await r.json()) as { s: string; page: string };
      window.location.href = `/${j.page}?s=${j.s}`;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  // If the code arrived via the QR (/enroll?c=CODE), resolve it automatically.
  useEffect(() => {
    if (initial) void resolveCode(initial);
  }, []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await resolveCode(code.trim().toUpperCase());
  }
  return (
    <div
      className="ark-enroll"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(6,5,3,0.5), rgba(6,5,3,0.82)), url(${castleBg})`,
      }}
    >
      <div className="ark-enroll-card">
        <h1>Enter your code</h1>
        <p>Type the code your agent gave you to set up or approve with Face ID.</p>
        <form onSubmit={submit}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
            autoFocus
            autoCapitalize="characters"
            maxLength={8}
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontSize: 30,
              letterSpacing: 8,
              textAlign: "center",
              padding: "14px 12px",
              textTransform: "uppercase",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.22)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              marginBottom: 14,
            }}
          />
          {err && <p className="ark-enroll-error">{err}</p>}
          <button type="submit" className="ark-enroll-btn" disabled={busy}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </form>
        <p className="ark-enroll-foot">ark · useark.app</p>
      </div>
    </div>
  );
}

export function Enroll() {
  const token = new URLSearchParams(window.location.search).get("s");
  const mobile = isMobileDevice();
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [error, setError] = useState("");

  // Desktop: watch the session so this page reflects the phone finishing.
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
      if (!optRes.ok) throw new Error("This code has expired. Start again from the ANTARA app.");
      const optionsJSON = await optRes.json();

      const attestation = await startRegistration({ optionsJSON });

      const verRes = await fetch(`${API_BASE}/vault/webauthn/phone/verify/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: attestation }),
      });
      const verJson = await verRes.json().catch(() => ({}));
      if (!verRes.ok || !verJson.verified) {
        throw new Error(verJson.error || "Could not confirm. Please try again.");
      }
      setState("done");
    } catch (e) {
      setState("error");
      const msg = e instanceof Error ? e.message : String(e);
      setError(/NotAllowed|aborted|cancel/i.test(msg) ? "Face ID was cancelled." : msg);
    }
  }

  // No token in the URL: let the user type the short code their agent gave them.
  if (!token) return <CodeEntry />;

  return (
    <div
      className="ark-enroll"
      style={{
        backgroundImage: `linear-gradient(180deg, rgba(6,5,3,0.5), rgba(6,5,3,0.82)), url(${castleBg})`,
      }}
    >
      <div className="ark-enroll-card">
        {state === "done" ? (
          <>
            <div className="ark-enroll-check">✓</div>
            <h1>Face ID activated</h1>
            <p>Your vault is now protected. You can return to the ANTARA app — it has already continued.</p>
          </>
        ) : !mobile ? (
          <>
            <h1>Activate Face ID</h1>
            <p>
              Face ID lives on your phone. Scan this with your phone’s camera to add it as a
              guardian of your ANTARA vault.
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
            <h1>Activate Face ID</h1>
            <p>
              Confirm with your phone’s Face ID or fingerprint to add this device as a
              guardian of your ANTARA vault.
            </p>
            {state === "error" && <p className="ark-enroll-error">{error}</p>}
            <button
              type="button"
              className="ark-enroll-btn"
              disabled={state === "working"}
              onClick={run}
            >
              {state === "working" ? "Waiting for Face ID…" : "Confirm with Face ID"}
            </button>
            <p className="ark-enroll-foot">ark · useark.app</p>
          </>
        )}
      </div>
    </div>
  );
}
