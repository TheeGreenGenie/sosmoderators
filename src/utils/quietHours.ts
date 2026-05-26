import type { SubConfig } from '../redis/schema.js';

export function shouldDeliverNow(config: SubConfig, isCritical: boolean): boolean {
  if (isCritical || !config.quietHours.enabled) return true;
  const hour = new Date().getUTCHours();
  const { startHour, endHour } = config.quietHours;
  if (startHour < endHour) return hour < startHour || hour >= endHour;
  return hour >= endHour && hour < startHour;
}
