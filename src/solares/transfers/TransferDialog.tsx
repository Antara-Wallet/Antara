// Retired: the single-form direct-transfer dialog was replaced by the four-step SendFlow
// (docs/UI_ARGUS_PARITY.md 6.8, integration pass). The module stays as a re-export so an
// old import path keeps resolving to the current Send screen.
export { SendFlow, SendFlow as TransferDialog } from './SendFlow';
export type { SendFlowProps } from './SendFlow';
