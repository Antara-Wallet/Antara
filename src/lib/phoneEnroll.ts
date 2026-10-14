// Tiny external store driving the in-app "scan with your phone" QR modal, used by
// both Face ID enrollment and transaction approval. The flow pushes a URL + copy
// here; <PhoneEnrollModal> renders it; the user can cancel. Keeps WebAuthn out of
// the OS dialog and inside our UI.

type Listener = () => void;

export interface PhonePrompt {
  url: string;
  title: string;
  subtitle: string;
}

let _prompt: PhonePrompt | null = null;
let _onCancel: (() => void) | null = null;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

export const phoneEnrollStore = {
  show(prompt: PhonePrompt, onCancel: () => void) {
    _prompt = prompt;
    _onCancel = onCancel;
    emit();
  },
  hide() {
    _prompt = null;
    _onCancel = null;
    emit();
  },
  cancel() {
    _onCancel?.();
  },
  get: () => _prompt,
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
