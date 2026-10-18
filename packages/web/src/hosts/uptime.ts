// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/** Uptime in its two largest units, as the host's header shows it: "12 d 4 h", "4 h 5 min", "5 min". */
export function uptimeText(seconds: number): { key: 'usage.uptimeDays' | 'usage.uptimeHours' | 'usage.uptimeMinutes'; vars: Record<string, number> } {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return { key: 'usage.uptimeDays', vars: { days, hours: hours % 24 } };
  if (hours > 0) return { key: 'usage.uptimeHours', vars: { hours, minutes: minutes % 60 } };
  return { key: 'usage.uptimeMinutes', vars: { minutes } };
}

/** When the host booted: the time of the reading less its uptime. */
export function bootTime(readAt: string, uptime: number): Date {
  return new Date(Date.parse(readAt) - uptime * 1000);
}
