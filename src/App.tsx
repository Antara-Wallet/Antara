import { useEffect, useMemo, useState } from "react";
import { Landing } from "./screens/Landing";
import { SetPassword } from "./screens/SetPassword";
import { RecoveryPhrase } from "./screens/RecoveryPhrase";
import { SecuritySetup } from "./screens/SecuritySetup";
import { ImportWallet } from "./screens/ImportWallet";
import { Unlock } from "./screens/Unlock";
import { Dashboard } from "./screens/Dashboard";
import { PhoneEnrollModal } from "./components/PhoneEnrollModal";
import { toWallets, type DerivedWallet } from "./lib/wallet";
import { getMeta, setMeta } from "./lib/walletMeta";
import {
  vaultExists,
  createVault,
  importVault,
  addAccount,
  importAccount,
  lockVault,
} from "./lib/vault";
import { isDemoMode } from "./lib/demo";

type Step =
  | "loading"
  | "landing"
  | "create-password"
  | "recovery"
  | "security"
  | "import"
  | "import-password"
  | "unlock"
  | "dashboard";

export default function App() {
  const [step, setStep] = useState<Step>("loading");
  const [wallets, setWallets] = useState<DerivedWallet[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [backupPhrase, setBackupPhrase] = useState(""); // only during create flow
  const [importPhrase, setImportPhrase] = useState(""); // only during import flow
  const [metaTick, setMetaTick] = useState(0); // bump to re-read wallet metadata

  useEffect(() => {
    // Demo mode skips the marketing landing (it has no create-wallet path) and
    // drops straight into onboarding for a clean recording.
    const fresh = () => (isDemoMode() ? "create-password" : "landing");
    vaultExists()
      .then((ok) => setStep(ok ? "unlock" : fresh()))
      .catch(() => setStep(fresh()));
  }, []);

  // Overlay user labels onto derived wallets; drop ones the user hid.
  const visibleWallets = useMemo(() => {
    void metaTick;
    return wallets
      .map((w) => {
        const m = getMeta(w.address);
        return { ...w, name: m.label?.trim() || w.name };
      })
      .filter((w) => !getMeta(w.address).hidden);
  }, [wallets, metaTick]);

  async function addWallet() {
    const account = await addAccount();
    setWallets((w) => [...w, toWallets([account])[0]]);
    setActiveIndex(account.index);
  }

  // Import an external wallet (recovery phrase or private key). Throws on a bad
  // password / secret / duplicate, which the drawer surfaces inline.
  async function importWallet(secret: string, password: string) {
    const account = await importAccount(password, secret);
    setMeta(account.address, { label: "Imported wallet" });
    setWallets((w) => [...w, toWallets([account])[0]]);
    setActiveIndex(account.index);
    setMetaTick((t) => t + 1);
  }

  function renameWallet(index: number, name: string) {
    const w = wallets.find((x) => x.index === index);
    if (!w) return;
    setMeta(w.address, { label: name.trim() || undefined });
    setMetaTick((t) => t + 1);
  }

  function setWalletBackground(index: number, background: string) {
    const w = wallets.find((x) => x.index === index);
    if (!w) return;
    setMeta(w.address, { background });
    setMetaTick((t) => t + 1);
  }

  function removeWallet(index: number) {
    const w = wallets.find((x) => x.index === index);
    if (!w) return;
    setMeta(w.address, { hidden: true });
    if (activeIndex === index) {
      const next = wallets.find((x) => x.index !== index && !getMeta(x.address).hidden);
      if (next) setActiveIndex(next.index);
    }
    setMetaTick((t) => t + 1);
  }

  async function lock() {
    await lockVault();
    setWallets([]);
    setActiveIndex(0);
    setStep("unlock");
  }

  const screen = (() => {
    switch (step) {
    case "loading":
      return <div className="h-full w-full bg-base" />;

    case "landing":
      return (
        <Landing
          onCreate={() => setStep("create-password")}
          onImport={() => setStep("import")}
        />
      );

    case "create-password":
      return (
        <SetPassword
          onNext={async (password) => {
            const { mnemonic, account } = await createVault(password);
            setBackupPhrase(mnemonic);
            setWallets(toWallets([account]));
            setActiveIndex(0);
            setStep("recovery");
          }}
        />
      );

    case "recovery":
      return (
        <RecoveryPhrase
          mnemonic={backupPhrase}
          onNext={() => {
            setBackupPhrase(""); // drop the plaintext phrase from JS memory
            setStep("security");
          }}
        />
      );

    case "security":
      return <SecuritySetup onNext={() => setStep("dashboard")} />;

    case "import":
      return (
        <ImportWallet
          onImport={(phrase) => {
            setImportPhrase(phrase);
            setStep("import-password");
          }}
        />
      );

    case "import-password":
      return (
        <SetPassword
          onNext={async (password) => {
            const account = await importVault(password, importPhrase);
            setImportPhrase(""); // drop the phrase once it's sealed in Rust
            setWallets(toWallets([account]));
            setActiveIndex(0);
            setStep("security");
          }}
        />
      );

    case "unlock":
      return (
        <Unlock
          onUnlocked={(accounts) => {
            setWallets(toWallets(accounts));
            setActiveIndex(0);
            setStep("dashboard");
          }}
        />
      );

    case "dashboard":
      return (
        <Dashboard
          wallets={visibleWallets}
          activeIndex={activeIndex}
          onSwitch={setActiveIndex}
          onAddWallet={addWallet}
          onImportWallet={importWallet}
          onLock={lock}
          onRename={renameWallet}
          onSetBackground={setWalletBackground}
          onRemove={removeWallet}
        />
      );
    }
  })();

  return (
    <>
      {screen}
      <PhoneEnrollModal />
    </>
  );
}
