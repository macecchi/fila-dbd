import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep in sync with the exit duration in modals.css. */
const EXIT_MS = 150;

interface Props {
  isOpen: boolean;
  /** Backdrop click. */
  onClose: () => void;
  /** Class(es) for the dialog surface, e.g. "recovery-dialog". */
  className?: string;
  children: ReactNode;
}

/**
 * Shell for every modal. Portals to <body> — `.panel-surface` uses
 * backdrop-filter, which would otherwise become the containing block for the
 * overlay's position: fixed — and stays mounted through the exit transition.
 */
export function Dialog({ isOpen, onClose, className = '', children }: Props) {
  const [mounted, setMounted] = useState(isOpen);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      // Two frames: the first paints the closed styles, the second flips to
      // open. With one frame both land in the same paint and it snaps.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setVisible(false);
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [isOpen]);

  if (!mounted) return null;

  return createPortal(
    <div className="modal-overlay" data-state={visible ? 'open' : 'closed'} onClick={onClose}>
      <div className={`modal-surface ${className}`.trim()} onClick={e => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body
  );
}
