import { useState } from 'react';
import { startEnrolment } from '../api';
import { toKeycloakAuthorizationUrl } from '../config';

/**
 * Your steps 8-10: the user is already authenticated in the portal.
 * Clicking starts a SECOND redirect to Keycloak with an AIA parameter.
 * The WebAuthn UI (QR / USB / biometric) is rendered by Keycloak on
 * kc.gateway-vw.de — using your white-label theme so it feels like the portal.
 */
export function PasskeyBanner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnrol() {
    setBusy(true);
    setError(null);
    try {
      const { authorizationUrl } = await startEnrolment();

      const target = toKeycloakAuthorizationUrl(authorizationUrl);
      window.location.assign(target.toString());
    } catch {
      setError('Die Passkey-Einrichtung konnte nicht gestartet werden.');
      setBusy(false);
    }
  }

  return (
    <aside className="banner" role="status">
      <h2>Sichern Sie Ihr Konto mit einem Passkey</h2>
      <p>
        Ein Passkey ersetzt Ihr Passwort. Sie können dazu Ihren Fingerabdruck,
        Ihr Gesicht, einen USB-Sicherheitsschlüssel oder ein anderes Gerät
        verwenden.
      </p>
      <button type="button" onClick={handleEnrol} disabled={busy}>
        {busy ? 'Weiterleitung …' : 'Passkey jetzt erstellen'}
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => window.location.assign('/api/auth/logout')}
      >
        Später
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </aside>
  );
}
