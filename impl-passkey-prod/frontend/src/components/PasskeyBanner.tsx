import { ApiError, startEnrollment, logout } from '../api';
import { useState } from 'react';

export function PasskeyBanner() {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  async function createPasskey() {
    setBusy(true);
    setInfo(null);
    try {
      const navigated = await startEnrollment();
      if (!navigated) setInfo('Für dieses Konto ist bereits ein Passkey eingerichtet.');
    } catch (err) {
      setInfo(err instanceof ApiError ? err.message : 'Die Passkey-Einrichtung konnte nicht gestartet werden.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card--accent" aria-labelledby="passkey-heading">
      <h2 id="passkey-heading">Passkey jetzt erstellen</h2>
      <p>
        Sie sind angemeldet. Erstellen Sie jetzt einen Passkey, damit Sie sich künftig ohne Verimi anmelden können —
        auch nach der Abschaltung von Verimi Ende 2026.
      </p>
      <ul className="hint-list">
        <li>Fingerabdruck, Gesichtserkennung oder Security-Key nutzbar</li>
        <li>Der private Schlüssel bleibt auf Ihrem Gerät</li>
        <li>Dauer: weniger als eine Minute</li>
      </ul>
      <button type="button" className="button button--primary" disabled={busy} onClick={() => void createPasskey()}>
        {busy ? 'Wird geöffnet …' : 'Passkey erstellen'}
      </button>
      {info && <p className="hint" role="status">{info}</p>}
      <p className="hint">
        <button type="button" className="link-button" onClick={logout}>Abmelden</button>
      </p>
    </section>
  );
}
