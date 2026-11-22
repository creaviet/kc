interface Props {
  login?: string | null;
  reason?: string | null;
  passkey?: string | null;
  loggedOut?: string | null;
}

/** The BFF returns to a FIXED path with fixed status codes — never user input. */
export function StatusMessage({ login, reason, passkey, loggedOut }: Props) {
  const messages: string[] = [];

  if (loggedOut === '1') messages.push('Sie sind abgemeldet.');
  if (login === 'success') messages.push('Sie sind angemeldet.');
  if (login === 'error') {
    messages.push(
      reason === 'access_denied'
        ? 'Die Anmeldung wurde abgebrochen.'
        : 'Die Anmeldung ist fehlgeschlagen. Bitte versuchen Sie es erneut.',
    );
  }
  if (passkey === 'created') {
    messages.push('Passkey erfolgreich erstellt. Sie können sich damit anmelden.');
  }
  if (passkey === 'not_confirmed') {
    messages.push('Der Passkey konnte noch nicht bestätigt werden. Bitte versuchen Sie es erneut.');
  }

  if (messages.length === 0) return null;

  const isError = login === 'error' || passkey === 'not_confirmed';

  return (
    <div className={isError ? 'status error' : 'status'} role="status">
      {messages.map((message) => <p key={message}>{message}</p>)}
    </div>
  );
}
