// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { Counter, LiveState } from '@hopdeck/core';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { toErrorInfo, type ErrorInfo } from '../../components/ErrorCallout.tsx';

/** A live look at the host, with how fast each counter grew since the look before. */
export interface LiveInfo {
  state: LiveState;
  /** Per second, by the same keys as the state; only counters seen in both looks. */
  rates: { rules: Record<string, Counter>; counters: Record<string, Counter> };
}

export interface LiveResult {
  info: LiveInfo | undefined;
  error: ErrorInfo | undefined;
}

/**
 * Polls counters and table fingerprints every `seconds` while `active`, and
 * pauses while the browser tab is hidden. 0 seconds means off.
 */
export function useLive(hostId: string, seconds: number, active: boolean): LiveResult {
  const [info, setInfo] = useState<LiveInfo>();
  const [error, setError] = useState<ErrorInfo>();
  const previous = useRef<LiveState | undefined>(undefined);

  useEffect(() => {
    if (!active || seconds <= 0) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const { live } = await api.get<{ live: LiveState }>(`/hosts/${encodeURIComponent(hostId)}/live`);
          if (stopped) return;
          const before = previous.current;
          previous.current = live;
          setInfo({ state: live, rates: before === undefined ? { rules: {}, counters: {} } : rates(before, live) });
          setError(undefined);
        } catch (caught) {
          if (!stopped) setError(toErrorInfo(caught));
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), seconds * 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [hostId, seconds, active]);

  return { info, error };
}

function rates(before: LiveState, after: LiveState): LiveInfo['rates'] {
  const elapsed = (Date.parse(after.readAt) - Date.parse(before.readAt)) / 1000;
  const per = (old: Record<string, Counter>, now: Record<string, Counter>) => {
    const result: Record<string, Counter> = {};
    for (const [key, counter] of Object.entries(now)) {
      const earlier = old[key];
      // A counter that went down was reset, e.g. by a replaced table: no rate this time.
      if (earlier === undefined || elapsed <= 0 || counter.packets < earlier.packets) continue;
      result[key] = { packets: (counter.packets - earlier.packets) / elapsed, bytes: (counter.bytes - earlier.bytes) / elapsed };
    }
    return result;
  };
  return { rules: per(before.rules, after.rules), counters: per(before.counters, after.counters) };
}
