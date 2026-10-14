// Operator diagnostics shared by the CAPTCHA stubs. Privy only renders a CAPTCHA
// widget when bot protection is enabled for the app client, which the extension
// cannot support (the widget scripts are remotely hosted code).
export const CAPTCHA_UNAVAILABLE = 'captcha_unavailable_in_extension';

const NOTICE = '[ANTARA extension] Privy CAPTCHA (%s) is enabled for this app client but unsupported in the extension; disable bot protection for the extension client in the Privy dashboard. Login fails with "Captcha failed" (after up to about 20 s); the adblocker/VPN hint Privy shows does not apply.';

export function reportCaptchaUnsupported(provider: 'turnstile' | 'hcaptcha', stage: 'mount' | 'execute') {
  console.error(`${NOTICE} [${stage}]`, provider);
}
