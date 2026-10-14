// Inert replacement for @marsidev/react-turnstile in the Chrome extension build.
// Chrome Web Store forbids remotely hosted code, and Cloudflare Turnstile loads its
// script from challenges.cloudflare.com. CAPTCHA must be disabled for the Privy app
// client used by the extension; if it is not, this stub fails closed (no token is
// ever produced) and logs the cause for the operator.
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import { CAPTCHA_UNAVAILABLE, reportCaptchaUnsupported } from './captchaNotice';

type TurnstileProps = {
  onError?: (error?: unknown) => void;
  onUnsupported?: () => void;
};

export type TurnstileInstance = {
  execute: () => void;
  reset: () => void;
  remove: () => void;
  render: () => void;
  getResponse: () => string | undefined;
  getResponsePromise: () => Promise<string>;
  isExpired: () => boolean;
};

export const Turnstile = forwardRef<TurnstileInstance | undefined, TurnstileProps>(function Turnstile(props, ref) {
  const fail = () => {
    reportCaptchaUnsupported('turnstile', 'execute');
    props.onError?.(CAPTCHA_UNAVAILABLE);
  };
  useImperativeHandle(ref, () => ({
    execute: fail,
    reset: () => undefined,
    remove: () => undefined,
    render: fail,
    getResponse: () => undefined,
    getResponsePromise: () => Promise.reject(new Error(CAPTCHA_UNAVAILABLE)),
    isExpired: () => true,
  }));
  useEffect(() => {
    reportCaptchaUnsupported('turnstile', 'mount');
    props.onError?.(CAPTCHA_UNAVAILABLE);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
});

export default Turnstile;
