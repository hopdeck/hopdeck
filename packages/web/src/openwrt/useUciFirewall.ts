// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import { addUciChange, nextRef, openwrtFirewall, previewUci, type OpenWrtFirewall, type UciChange, type UciConfig } from '@hopdeck/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { toErrorInfo, type ErrorInfo } from '../components/ErrorCallout.tsx';

export interface UciFirewallState {
  /** The firewall configuration as committed on the router. */
  base: UciConfig | undefined;
  /** Its file's hash: plans are made on it, and refused if the router's changed since. */
  hash: string | undefined;
  /** /etc/config/network, for the names of the networks zones take. */
  network: UciConfig | undefined;
  loading: boolean;
  error: ErrorInfo | undefined;
  /** Changes collected in the panel, not on the router yet. */
  pending: UciChange[];
  /** The configuration with them, and its firewall, as the tabs show it. */
  preview: UciConfig | undefined;
  firewall: OpenWrtFirewall | undefined;
  /** Adds edits to the pending changes; each merges with what is pending for the same section. */
  change(changes: readonly UciChange[]): void;
  /** A ref for a section the panel adds. */
  ref(): string;
  discard(): void;
  /** Reads the router's configuration again, keeping the pending changes unless told to drop them. */
  reload(options?: { discard?: boolean }): void;
}

/** The firewall of an OpenWrt host through UCI, and the changes collected for it before review. */
export function useUciFirewall(hostId: string, active: boolean): UciFirewallState {
  const [base, setBase] = useState<UciConfig>();
  const [hash, setHash] = useState<string>();
  const [network, setNetwork] = useState<UciConfig>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorInfo>();
  const [pending, setPending] = useState<UciChange[]>([]);
  const [reads, setReads] = useState(0);
  // Pending changes the next reading makes obsolete, as it has them already: dropped when it arrives, not before.
  const dropOnRead = useRef(false);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    setError(undefined);
    const host = encodeURIComponent(hostId);
    Promise.all([
      api.get<{ config: UciConfig; hash: string }>(`/hosts/${host}/uci/firewall`),
      // The network's names only help to pick them; a router can do without.
      api.get<{ config: UciConfig }>(`/hosts/${host}/uci/network`).catch(() => undefined),
    ]).then(
      ([firewall, networks]) => {
        if (!current) return;
        setBase(firewall.config);
        setHash(firewall.hash);
        if (dropOnRead.current) {
          dropOnRead.current = false;
          setPending([]);
        }
        setNetwork(networks?.config);
        setLoading(false);
      },
      (caught: unknown) => {
        if (!current) return;
        setError(toErrorInfo(caught));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [hostId, active, reads]);

  const preview = useMemo(() => (base === undefined ? undefined : previewUci(base, pending)), [base, pending]);
  const firewall = useMemo(() => (preview === undefined ? undefined : openwrtFirewall(preview)), [preview]);
  const change = useCallback(
    (changes: readonly UciChange[]) => {
      if (base === undefined) return;
      setPending((current) => changes.reduce((list, next) => addUciChange(base, list, next), current));
    },
    [base],
  );
  const ref = useCallback(() => nextRef(pending), [pending]);
  const discard = useCallback(() => setPending([]), []);
  const reload = useCallback((options: { discard?: boolean } = {}) => {
    if (options.discard === true) dropOnRead.current = true;
    setReads((count) => count + 1);
  }, []);

  return { base, hash, network, loading, error, pending, preview, firewall, change, ref, discard, reload };
}

/** Sections a pending change touches, by name, or by ref for added ones: the tabs mark their rows. */
export function touchedSections(pending: readonly UciChange[]): Set<string> {
  return new Set(pending.flatMap((change) => (change.kind === 'order' ? [] : change.kind === 'add' ? (change.ref === undefined ? [] : [change.ref]) : [change.section])));
}
