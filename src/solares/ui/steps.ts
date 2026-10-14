/** Pure step-state logic behind Stepper (docs/UI_ARGUS_PARITY.md 4.4: Send, Activation, Verification). */

export type StepStatus = 'complete' | 'current' | 'upcoming';

export interface StepItem {
  /** 1-based, as shown. */
  number: number;
  label: string;
  status: StepStatus;
}

/**
 * The visible state of each step when step `current` (0-based) is active. `current` is
 * clamped to the list, so a stale index can never mark a step complete that the flow
 * has not reached; pass `steps.length` only when every step is done.
 */
export function stepItems(steps: readonly string[], current: number): StepItem[] {
  const at = Number.isFinite(current) ? Math.max(0, Math.min(Math.trunc(current), steps.length)) : 0;
  return steps.map((label, index) => ({
    number: index + 1,
    label,
    status: index < at ? 'complete' : index === at ? 'current' : 'upcoming',
  }));
}

/** "1 Asset · 2 Details · 3 Review · 4 Result": the stepper's accessible summary. */
export function stepSummary(steps: readonly string[]): string {
  return steps.map((label, index) => `${index + 1} ${label}`).join(' · ');
}
