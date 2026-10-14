// Inert replacement for @stripe/crypto in the Chrome extension build. The Stripe
// onramp loader injects scripts from js.stripe.com / crypto-js.stripe.com, which is
// remotely hosted code. ANTARA does not offer Privy card onramp in the extension.
const UNAVAILABLE = 'Card onramp is not available in the ANTARA extension.';

export async function loadStripeOnramp(): Promise<null> {
  return null;
}

export async function loadCryptoOnrampAndInitialize(): Promise<never> {
  throw new Error(UNAVAILABLE);
}
