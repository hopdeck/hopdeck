import type { RulesetSnapshot } from '@hopdeck/core';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { toErrorInfo, type ErrorInfo } from '../../components/ErrorCallout.tsx';
import { buildModel, type RulesetModel } from './model.ts';

export interface RulesetState {
  loading: boolean;
  /** The last ruleset read; kept while refreshing and after a failed refresh. */
  model: RulesetModel | undefined;
  error: ErrorInfo | undefined;
  reload(): void;
}

/** Reads a host's ruleset once `enabled` (nft can run as root there), and on reload(). */
export function useRuleset(hostId: string, enabled: boolean): RulesetState {
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState<RulesetModel>();
  const [error, setError] = useState<ErrorInfo>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { ruleset } = await api.get<{ ruleset: RulesetSnapshot }>(`/hosts/${encodeURIComponent(hostId)}/ruleset`);
      setModel(buildModel(ruleset));
      setError(undefined);
    } catch (caught) {
      setError(toErrorInfo(caught));
    } finally {
      setLoading(false);
    }
  }, [hostId]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return { loading, model, error, reload: () => void load() };
}
