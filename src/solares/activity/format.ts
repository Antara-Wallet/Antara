/** Display helpers shared by the Activity rows and the detail sheet. */
import type { IconName } from '../ui';
import type { ActivityItem } from './activityModel';

/** One functional icon per kind of record (no decorative art). */
export function activityIcon(item: Pick<ActivityItem, 'kind' | 'vault'>): IconName {
  if (item.kind === 'Swap') return 'swap';
  if (item.kind === 'Vault') return item.vault?.kind === 'deposit' ? 'deposit' : item.vault?.kind === 'release' ? 'release' : 'vault';
  return 'up';
}

/** "Oct 12, 2026", or "Oct 12, 2026, 9:30 AM" with the time, in the viewer's locale and time zone. */
export function formatActivityDate(timestamp: number, withTime = false, locale?: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Date unknown';
  return withTime
    ? date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}
