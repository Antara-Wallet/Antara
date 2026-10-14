// Inert replacement for @hcaptcha/react-hcaptcha in the Chrome extension build.
// hCaptcha loads its script from js.hcaptcha.com, which Chrome Web Store treats as
// remotely hosted code. CAPTCHA must be disabled for the extension's Privy client;
// if it is not, this stub fails closed (no token) and logs the cause.
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import { CAPTCHA_UNAVAILABLE, reportCaptchaUnsupported } from './captchaNotice';

type HCaptchaProps = {
  onError?: (error?: unknown) => void;
  onLoad?: () => void;
};

export type HCaptchaInstance = {
  execute: () => Promise<never>;
  resetCaptcha: () => void;
  removeCaptcha: () => void;
  getResponse: () => string;
  getRespKey: () => string;
  setData: () => void;
  isReady: () => boolean;
};

const HCaptcha = forwardRef<HCaptchaInstance, HCaptchaProps>(function HCaptcha(props, ref) {
  useImperativeHandle(ref, () => ({
    execute: () => {
      reportCaptchaUnsupported('hcaptcha', 'execute');
      props.onError?.(CAPTCHA_UNAVAILABLE);
      return Promise.reject(new Error(CAPTCHA_UNAVAILABLE));
    },
    resetCaptcha: () => undefined,
    removeCaptcha: () => undefined,
    getResponse: () => '',
    getRespKey: () => '',
    setData: () => undefined,
    isReady: () => false,
  }));
  useEffect(() => {
    reportCaptchaUnsupported('hcaptcha', 'mount');
    props.onError?.(CAPTCHA_UNAVAILABLE);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
});

export default HCaptcha;
