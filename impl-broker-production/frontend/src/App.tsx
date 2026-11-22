import { useEffect, useState } from 'react';
import { getMe } from './api';
import type { MeResponse } from './types';
import { LoginPanel } from './components/LoginPanel';
import { PasskeyBanner } from './components/PasskeyBanner';
import { StatusMessage } from './components/StatusMessage';

// Capture the status once at load time. The BFF redirects to a FIXED path
// (/?) with fixed status codes, so nothing here is attacker-controlled HTML.
const initialStatus = (() => {
  const params = new URLSearchParams(window.location.search);
  return {
    login: params.get('login'),
    reason: params.get('reason'),
    passkey: params.get('passkey'),
    loggedOut: params.get('logged_out'),
  };
})();

export function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch(() => setLoadError(true));

    // Keep the address bar clean — status was already captured above.
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  return (
    <main className="page">
      <StatusMessage {...initialStatus} />

      {loadError && <p className="error" role="alert">Der Anmeldestatus konnte nicht geladen werden.</p>}

      {!me && !loadError && <p className="muted">Lädt …</p>}

      {me && !me.authenticated && <LoginPanel phase={me.phase} />}

      {me?.authenticated && (
        <>
          <section className="card">
            <h1>Mein Konto</h1>
            <p>Sie sind angemeldet.</p>
            <button
              type="button"
              className="secondary"
              onClick={() => window.location.assign('/api/auth/logout')}
            >
              Abmelden
            </button>
          </section>

          {/* Your step 8: urge the user to create a passkey while Verimi is alive. */}
          {!me.passkeyEnrolled && <PasskeyBanner />}

          {me.passkeyEnrolled && (
            <p className="hint">
              Passkey aktiv — nach dem Abmelden können Sie sich direkt damit anmelden.
            </p>
          )}
        </>
      )}
    </main>
  );
}
