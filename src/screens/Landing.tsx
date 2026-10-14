import AntaraLanding from '../solares/landing/AntaraLanding';

/** Keep the legacy entry route pointed at the current public introduction. */
export function Landing(_props: { onCreate: () => void; onImport: () => void }) {
  return <AntaraLanding />;
}
