import { useState } from 'react';
import { startLogin } from '../api';
import { toKeycloakAuthorizationUrl } from '../config';
import type { LoginMethod, MeResponse } from '../types';

interface Props {
  phase: MeResponse['phase'];
}

const ERROR_TEXT: Record<LoginMethod, string> = {
  passkey: 'Die Passkey-Anmeldung konnte nicht gestartet werden.',
  verimi: 'Die Verimi-Anmeldung konnte nicht gestartet werden.',
  auto: 'Login konnte nicht gestartet werden. Bitte versuchen Sie es erneut.',
};

/**
 * Your step 1. The user explicitly chooses the login method.
 * The BFF builds the OIDC URL; the browser only navigates there.
 */
export function LoginPanel({ phase }: Props) {
  const [busyMethod, setBusyMethod] = useState<LoginMethod | null>(null);
  const [error, setError] = useState<string | null>(null);

  const passkeySupported = typeof window !== 'undefined' && 'PublicKeyCredential' in window;

  async function handleLogin(method: LoginMethod) {
    setBusyMethod(method);
    setError(null);
    try {
      const { authorizationUrl } = await startLogin(method);

      // Defensive check: only navigate to OUR configured Keycloak origin.
      const target = toKeycloakAuthorizationUrl(authorizationUrl);
      window.location.assign(target.toString());
    } catch {
      setError(ERROR_TEXT[method]);
      setBusyMethod(null);
    }
  }

  return (
    <section className="card" aria-labelledby="login-heading">
      <h1 id="login-heading">Willkommen</h1>
      <p>Bitte wählen Sie, wie Sie sich anmelden möchten.</p>

      {phase === 'B' && passkeySupported && (
        <button
          type="button"
          onClick={() => handleLogin('passkey')}
          disabled={busyMethod !== null}
        >
          {busyMethod === 'passkey' ? 'Weiterleitung …' : 'Mit Passkey anmelden'}
        </button>
      )}

      {phase === 'B' && (
        <button
          type="button"
          className="secondary"
          onClick={() => handleLogin('verimi')}
          disabled={busyMethod !== null}
        >
          {busyMethod === 'verimi' ? 'Weiterleitung …' : 'Mit Verimi anmelden'}
        </button>
      )}

      {(phase === 'C' || !passkeySupported) && (
        <button
          type="button"
          onClick={() => handleLogin('auto')}
          disabled={busyMethod !== null}
        >
          {busyMethod === 'auto' ? 'Weiterleitung …' : 'Anmelden'}
        </button>
      )}

      {phase === 'B' && !passkeySupported && (
        <p className="muted">
          Dieser Browser unterstützt keine Passkeys. Bitte melden Sie sich mit Verimi an und
          erstellen Sie dort einen Passkey.
        </p>
      )}

      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
