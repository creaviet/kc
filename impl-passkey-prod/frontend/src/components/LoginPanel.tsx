import { ApiError, startLogin } from '../api';
import type { LoginMethod } from '../types';
import { useState } from 'react';

interface Props {
  verimiAvailable: boolean;
}

export function LoginPanel({ verimiAvailable }: Props) {
  const [busy, setBusy] = useState<LoginMethod | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function begin(method: LoginMethod) {
    setBusy(method);
    setError(null);
    try {
      await startLogin(method);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Die Anmeldung konnte nicht gestartet werden.');
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-labelledby="login-heading">
      <h2 id="login-heading">Anmelden</h2>
      <p className="muted">Wählen Sie Ihre Anmeldemethode.</p>

      <div className="button-stack">
        <button type="button" className="button button--primary" disabled={busy !== null} onClick={() => void begin('passkey')}>
          {busy === 'passkey' ? 'Wird geöffnet …' : 'Mit Passkey anmelden'}
        </button>
        {verimiAvailable && (
          <button type="button" className="button button--secondary" disabled={busy !== null} onClick={() => void begin('verimi')}>
            {busy === 'verimi' ? 'Wird geöffnet …' : 'Mit Verimi anmelden'}
          </button>
        )}
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <p className="hint">
        Die Anmeldung erfolgt über einen sicheren Anmeldedienst. Ihr Passkey verlässt niemals Ihr Gerät.
      </p>
    </section>
  );
}
