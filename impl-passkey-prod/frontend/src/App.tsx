import { useCallback, useEffect, useState } from 'react';
import { ApiError, fetchMe, logout } from './api';
import { VERIMI_AVAILABLE } from './config';
import type { MeResponse } from './types';
import { LoginPanel } from './components/LoginPanel';
import { PasskeyBanner } from './components/PasskeyBanner';
import { StatusMessage } from './components/StatusMessage';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; me: MeResponse }
  | { kind: 'error'; message: string };

function messageFromQuery(): { kind: 'success' | 'info' | 'error'; text: string } | null {
  const params = new URLSearchParams(window.location.search);
  const passkey = params.get('passkey');
  const login = params.get('login');

  if (passkey === 'created') return { kind: 'success', text: 'Ihr Passkey wurde erfolgreich eingerichtet.' };
  if (passkey === 'pending') return { kind: 'info', text: 'Der Passkey ist noch nicht bestätigt. Bitte versuchen Sie es erneut.' };
  if (login === 'error') return { kind: 'error', text: 'Die Anmeldung war nicht erfolgreich. Bitte versuchen Sie es erneut.' };
  if (login === 'success') return { kind: 'success', text: 'Sie sind angemeldet.' };
  if (params.get('logged_out') === '1') return { kind: 'info', text: 'Sie sind abgemeldet.' };
  return null;
}

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const queryMessage = messageFromQuery();

  const load = useCallback(async () => {
    try {
      const me = await fetchMe();
      setState({ kind: 'ready', me });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'Status konnte nicht geladen werden.' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="layout">
      <header className="header">
        <h1>Mein Portal</h1>
        <p className="muted">Sicherer Zugang mit Passkey</p>
      </header>

      {queryMessage && <StatusMessage kind={queryMessage.kind}>{queryMessage.text}</StatusMessage>}

      {state.kind === 'loading' && <p className="muted" role="status">Status wird geprüft …</p>}

      {state.kind === 'error' && (
        <section className="card">
          <StatusMessage kind="error">{state.message}</StatusMessage>
          <button type="button" className="button button--secondary" onClick={() => void load()}>Erneut versuchen</button>
        </section>
      )}

      {state.kind === 'ready' && (
        <>
          {state.me.authenticated ? (
            <>
              <section className="card">
                <h2>Willkommen</h2>
                <p>Sie sind angemeldet{state.me.email ? ` als ${state.me.email}` : ''}.</p>
                <p className="hint">
                  <button type="button" className="link-button" onClick={logout}>Abmelden</button>
                </p>
              </section>
              {!state.me.passkeyEnrolled && <PasskeyBanner />}
              {state.me.passkeyEnrolled && (
                <StatusMessage kind="success">Ihr Passkey ist eingerichtet. Sie können sich damit anmelden.</StatusMessage>
              )}
            </>
          ) : (
            <LoginPanel verimiAvailable={VERIMI_AVAILABLE} />
          )}
        </>
      )}
    </main>
  );
}
