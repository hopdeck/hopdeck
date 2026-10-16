// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { PACKET_LOG_LINES, type PacketLogEntry, type PacketLogView } from '@hopdeck/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { toErrorInfo, type ErrorInfo } from '../../components/ErrorCallout.tsx';

export interface PacketLogState {
  /** Newest first, at most PACKET_LOG_LINES. */
  entries: PacketLogEntry[];
  /** The last read, for its source and what the host said. */
  view: PacketLogView | undefined;
  error: ErrorInfo | undefined;
  loading: boolean;
  /** Reads now, whatever the interval. */
  refresh(): void;
}

/**
 * Reads the host's packet log every `seconds` while `active` (0: only on
 * refresh), pausing while the browser tab is hidden. From the journal it
 * reads on from the last line it has; other sources come whole each time.
 */
export function usePacketLog(hostId: string, active: boolean, seconds: number): PacketLogState {
  const [entries, setEntries] = useState<PacketLogEntry[]>([]);
  const [view, setView] = useState<PacketLogView>();
  const [error, setError] = useState<ErrorInfo>();
  const [loading, setLoading] = useState(false);
  const cursor = useRef<string | undefined>(undefined);
  const reading = useRef(false);
  const [asked, setAsked] = useState(0);

  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    setLoading(true);
    try {
      const after = cursor.current === undefined ? '' : `?after=${encodeURIComponent(cursor.current)}`;
      const { log } = await api.get<{ log: PacketLogView }>(`/hosts/${encodeURIComponent(hostId)}/packet-log${after}`);
      if (log.cursor !== undefined) cursor.current = log.cursor;
      else if (log.complete) cursor.current = undefined;
      setEntries((current) => (log.complete ? log.entries : [...log.entries, ...current].slice(0, PACKET_LOG_LINES)));
      setView(log);
      setError(undefined);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      reading.current = false;
      setLoading(false);
    }
  }, [hostId]);

  // Another host starts from nothing.
  useEffect(() => {
    cursor.current = undefined;
    setEntries([]);
    setView(undefined);
    setError(undefined);
  }, [hostId]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!document.hidden) await read();
      if (!stopped && seconds > 0) timer = setTimeout(() => void poll(), seconds * 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, seconds, read, asked]);

  return { entries, view, error, loading, refresh: () => setAsked((count) => count + 1) };
}
