import { useState, useRef, useEffect } from 'react';
import { useAuth, useChannel } from '../store';
import { handleLinkClick } from '../utils/helpers';
import { useTranslation } from '../i18n';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

export function HeaderMenu() {
  const { t, locale, setLocale } = useTranslation();
  const { channel } = useChannel();
  const { isAuthenticated, user, login, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const viewingOwnChannel = isAuthenticated && !!user && user.login.toLowerCase() === channel.toLowerCase();

  const handleNav = (e: React.MouseEvent<HTMLAnchorElement>) => {
    handleLinkClick(e);
    setOpen(false);
  };

  return (
    <div className="header-menu" ref={menuRef}>
      <button
        className="btn-icon header-menu-trigger"
        aria-label={t('menu.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>

      {open && (
        <div className="header-menu-dropdown" role="menu">
          <a className="context-menu-item" role="menuitem" href={`${basePath}/`} onClick={handleNav}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9.5 12 3l9 6.5" />
              <path d="M5 9v11h14V9" />
            </svg>
            <span>{t('menu.home')}</span>
          </a>

          {!viewingOwnChannel &&
            (isAuthenticated && user ? (
              <a className="context-menu-item" role="menuitem" href={`${basePath}/${user.login.toLowerCase()}`} onClick={handleNav}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
                <span>{t('menu.goToQueue')}</span>
              </a>
            ) : (
              <button className="context-menu-item" role="menuitem" onClick={() => { login(); setOpen(false); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5v14" />
                </svg>
                <span>{t('menu.startQueue')}</span>
              </button>
            ))}

          <a className="context-menu-item" role="menuitem" href={`${basePath}/${channel.toLowerCase()}/wrapped`} onClick={handleNav}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
              <path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />
            </svg>
            <span>{t('wrapped.menuItem')}</span>
          </a>

          <a className="context-menu-item" role="menuitem" href={`${basePath}/#faq`} onClick={handleNav}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7" />
              <path d="M12 17h.01" />
            </svg>
            <span>{t('menu.helpFaq')}</span>
          </a>

          <button
            className="context-menu-item"
            role="menuitem"
            onClick={() => { setLocale(locale === 'en' ? 'pt-BR' : 'en'); setOpen(false); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18" />
              <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
            </svg>
            <span>{locale === 'en' ? 'Português' : 'English'}</span>
          </button>

          {isAuthenticated && (
            <button className="context-menu-item danger" role="menuitem" onClick={() => { logout(); setOpen(false); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5M21 12H9" />
              </svg>
              <span>{t('header.disconnectTwitch')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
