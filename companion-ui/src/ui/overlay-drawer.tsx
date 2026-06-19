import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function OverlayFrame({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="overlay-root" role="presentation">
      <button className="overlay-backdrop" type="button" onClick={onClose} aria-label="Close overlay" />
      {children}
    </div>
  );
}

export function DrawerHeader({
  icon,
  onClose,
  title,
}: {
  icon: ReactNode;
  onClose: () => void;
  title: string;
}) {
  return (
    <header className="drawer-header">
      <div>
        {icon}
        <h1>{title}</h1>
      </div>
      <button type="button" onClick={onClose} aria-label={`Close ${title}`}>
        <X aria-hidden />
      </button>
    </header>
  );
}
