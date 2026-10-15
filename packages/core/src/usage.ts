// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

/** How busy a host is: CPU as top shows a process, memory as free counts it. */
export interface HostUsage {
  /** When hopdeck read it, ISO 8601. */
  readAt: string;
  cpu: {
    /** 100 is one thread fully busy, 200 two, up to 100 × threads. */
    percent: number;
    threads: number;
  };
  memory: {
    /** Bytes. */
    total: number;
    /** Bytes in use: total less what is available (MemAvailable), as free counts it. */
    used: number;
  };
}

/** CPU time out of /proc/stat's "cpu" line, in clock ticks. */
export interface CpuSample {
  busy: number;
  total: number;
  threads: number;
}

/** The shell command that prints what parseUsage() reads; any user may run it. */
export const USAGE_COMMAND = "grep '^cpu' /proc/stat; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo";

/** CPU time and memory out of USAGE_COMMAND's output. */
export function parseUsage(output: string): { cpu: CpuSample; memory: HostUsage['memory'] } {
  const total = /^cpu\s+(.+)$/m.exec(output);
  if (total === null) throw new Error(`no "cpu" line in /proc/stat: ${output.slice(0, 200)}`);
  // user nice system idle iowait irq softirq steal; guest time is already in user and nice.
  const ticks = total[1]!.trim().split(/\s+/).slice(0, 8).map(Number);
  const idle = (ticks[3] ?? 0) + (ticks[4] ?? 0);
  const sum = ticks.reduce((a, b) => a + b, 0);
  const threads = output.match(/^cpu\d+\s/gm)?.length ?? 1;

  const kib = (name: string) => {
    const found = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(output);
    if (found === null) throw new Error(`no ${name} in /proc/meminfo: ${output.slice(0, 200)}`);
    return Number(found[1]) * 1024;
  };
  const memoryTotal = kib('MemTotal');
  return { cpu: { busy: sum - idle, total: sum, threads }, memory: { total: memoryTotal, used: memoryTotal - kib('MemAvailable') } };
}

/** CPU use between two samples: 100 per fully busy thread. */
export function cpuPercent(before: CpuSample, after: CpuSample): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return Math.max(0, ((after.busy - before.busy) / total) * after.threads * 100);
}
