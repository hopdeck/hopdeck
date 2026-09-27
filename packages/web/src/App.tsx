// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostSummary } from '@hopdeck/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import styles from './App.module.css';
import { ErrorBody, errorTitle, toErrorInfo } from './components/ErrorCallout.tsx';
import { AlertIcon, LockIcon } from './components/icons.tsx';
import { TopBar } from './components/TopBar.tsx';
import { AddHostDialog } from './hosts/AddHostDialog.tsx';
import { HostList } from './hosts/HostList.tsx';
import { HostView } from './hosts/HostView.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';

type Load = { state: 'loading' } | { state: 'ready'; version: string } | { state: 'failed'; error: unknown };

export function App() {
  const { t } = useI18n();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [hosts, setHosts] = useState<HostSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [connecting, setConnecting] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    Promise.all([api.get<{ version: string }>('/health'), api.get<{ hosts: HostSummary[] }>('/hosts')]).then(
      ([health, list]) => {
        setHosts(list.hosts);
        setSelectedId(list.hosts[0]?.id);
        setLoad({ state: 'ready', version: health.version });
      },
      (error: unknown) => setLoad({ state: 'failed', error }),
    );
  }, []);

  const replaceHost = useCallback((host: HostSummary) => {
    setHosts((list) => list.map((item) => (item.id === host.id ? host : item)));
  }, []);

  const connect = useCallback(
    async (id: string) => {
      setConnecting((set) => new Set(set).add(id));
      try {
        const { host } = await api.post<{ host: HostSummary }>(`/hosts/${encodeURIComponent(id)}/connect`);
        replaceHost(host);
      } catch (caught) {
        const { code, message } = toErrorInfo(caught);
        const error = { code, detail: message };
        setHosts((list) => list.map((item) => (item.id === id ? { ...item, status: { state: 'error', error } } : item)));
      } finally {
        setConnecting((set) => {
          const next = new Set(set);
          next.delete(id);
          return next;
        });
      }
    },
    [replaceHost],
  );

  const selected = hosts.find((host) => host.id === selectedId);

  // A host connects the first time it is shown.
  useEffect(() => {
    if (selected?.status.state === 'new' && !connecting.has(selected.id)) void connect(selected.id);
  }, [selected, connecting, connect]);

  async function remove(host: HostSummary) {
    if (!window.confirm(t('host.removeConfirm', { name: host.name }))) return;
    await api.delete(`/hosts/${encodeURIComponent(host.id)}`);
    setHosts((list) => list.filter((item) => item.id !== host.id));
    setSelectedId(hosts[0]?.id);
  }

  async function unlock(id: string, password: string) {
    const { host } = await api.post<{ host: HostSummary }>(`/hosts/${encodeURIComponent(id)}/sudo-password`, { password });
    replaceHost(host);
  }

  if (load.state !== 'ready') {
    return (
      <div className={styles.shell}>
        <TopBar />
        <div className={styles.center}>
          {load.state === 'loading' ? (
            <p className={styles.loading} role="status">
              <span className="spinner" aria-hidden="true" />
              {t('app.loading')}
            </p>
          ) : (
            <FailedToLoad error={load.error} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <TopBar version={load.version} />
      <div className={styles.body}>
        <HostList
          hosts={hosts}
          selectedId={selectedId}
          connecting={connecting}
          onSelect={setSelectedId}
          onAdd={() => setAdding(true)}
        />
        <main className={styles.main}>
          {selected && (
            <HostView
              key={selected.id}
              host={selected}
              connecting={connecting.has(selected.id)}
              onConnect={() => void connect(selected.id)}
              onRemove={() => void remove(selected)}
              onUnlock={(password) => unlock(selected.id, password)}
              onUpdate={replaceHost}
            />
          )}
        </main>
      </div>
      <AddHostDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(host) => {
          setHosts((list) => [...list, host]);
          setSelectedId(host.id);
          setAdding(false);
        }}
      />
    </div>
  );
}

function FailedToLoad({ error }: { error: unknown }) {
  const { t } = useI18n();
  const info = toErrorInfo(error);
  return (
    <div className={styles.message} role="alert">
      <span className={styles.messageIcon}>{info.code === 'unauthorized' ? <LockIcon /> : <AlertIcon />}</span>
      <h1 className={styles.messageTitle}>{errorTitle(t, info.code)}</h1>
      <div className={styles.messageText}>
        <ErrorBody error={info} />
      </div>
    </div>
  );
}
