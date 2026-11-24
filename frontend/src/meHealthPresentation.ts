import type { HealthItem } from './healthCheck';

/** Heartbeat age is diagnostic evidence, not a senior-facing Me-tab warning.
 * Keep the original observations untouched for Diagnostics and monitoring.
 */
export function meHealthItems(items: HealthItem[]): HealthItem[] {
  return items.filter((item) =>
    !/^(Last background heartbeat:|Background heartbeat:)/.test(item.label));
}
