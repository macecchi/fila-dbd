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

          <a className="context-menu-item" role="menuitem" href={`${basePath}/#faq`} onClick={handleNav}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7" />
              <path d="M12 17h.01" />
            </svg>
            <span>{t('menu.helpFaq')}</span>
          </a>

          <a className="context-menu-item" role="menuitem" href="https://discord.gg/hXsAgk5KnX" target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
            </svg>
            <span>{t('menu.discord')}</span>
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
