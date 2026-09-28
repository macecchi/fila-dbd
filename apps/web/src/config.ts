// Dev fallbacks derive the host from the page URL so the app also works when
// opened from another device on the LAN (e.g. a phone hitting http://<lan-ip>:5173),
// where "localhost" would point at the device itself. Production always sets the env vars.
const devHost = typeof window !== 'undefined' ? window.location.hostname : 'localhost';

// Dev over `tailscale serve` (https://<machine>.<tailnet>.ts.net): the page is a
// real secure context (needed for navigator.share with files), and the API/PartyKit
// are proxied on Tailscale's allowed HTTPS ports — 8443 → 8787, 10000 → 1999.
const devSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';

export const API_URL: string =
  import.meta.env.VITE_API_URL ||
  (devSecure ? `https://${devHost}:8443` : `http://${devHost}:8787`);

export const PARTY_HOST: string =
  import.meta.env.VITE_PARTY_HOST || (devSecure ? `${devHost}:10000` : `${devHost}:1999`);

// PartySocket infers wss:// for any host it doesn't recognize as local, which
// breaks the plain-HTTP dev server on LAN/Tailscale IPs (e.g. 100.x). Force the
// protocol to match the dev page; leave undefined in prod so the default (wss) applies.
export const PARTY_PROTOCOL: 'ws' | 'wss' | undefined =
  import.meta.env.VITE_PARTY_HOST ? undefined : devSecure ? 'wss' : 'ws';
