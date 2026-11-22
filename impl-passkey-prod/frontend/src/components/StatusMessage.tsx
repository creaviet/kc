interface Props {
  kind: 'success' | 'info' | 'error';
  children: React.ReactNode;
}

export function StatusMessage({ kind, children }: Props) {
  return (
    <div className={`status status--${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      {children}
    </div>
  );
}
