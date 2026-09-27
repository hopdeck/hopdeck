// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostUsage } from '@hopdeck/core';
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';

/** How often the host's CPU and memory use is read. */
const SECONDS = 3;

/** Reads the host's CPU and memory use every few seconds while `active`; pauses while the browser tab is hidden. */
export function useUsage(hostId: string, active: boolean): { usage: HostUsage | undefined; error: ErrorInfo | undefined } {
  const [usage, setUsage] = useState<HostUsage>();
  const [error, setError] = useState<ErrorInfo>();

  useEffect(() => {
    setUsage(undefined);
    setError(undefined);
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const { usage: read } = await api.get<{ usage: HostUsage }>(`/hosts/${encodeURIComponent(hostId)}/usage`);
          if (stopped) return;
          setUsage(read);
          setError(undefined);
        } catch (caught) {
          if (!stopped) setError(toErrorInfo(caught));
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), SECONDS * 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hostId, active]);

  return { usage, error };
}
