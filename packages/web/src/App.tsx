import { useEffect, useState } from 'react';
import { ApiError, apiGet } from './api.ts';

interface Health {
  ok: boolean;
  version: string;
}

type State = { kind: 'loading' } | { kind: 'ready'; health: Health } | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    apiGet<Health>('/health').then(
      (health) => setState({ kind: 'ready', health }),
      (error: unknown) => setState({ kind: 'error', message: describeError(error) }),
    );
  }, []);

  return (
    <main>
      <h1>nftm</h1>
      {state.kind === 'loading' && <p>Connecting…</p>}
      {state.kind === 'ready' && <p>Connected to the nftm backend {state.health.version}.</p>}
      {state.kind === 'error' && <p role="alert">{state.message}</p>}
    </main>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'Not authorized. Open the URL printed by the nftm command.';
  }
  return error instanceof Error ? error.message : String(error);
}
