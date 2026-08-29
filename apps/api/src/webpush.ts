// Minimal Web Push sender for Cloudflare Workers: VAPID (RFC 8292) auth plus
// aes128gcm payload encryption (RFC 8291/8188), all on crypto.subtle. The npm
// `web-push` package is Node-only, hence the hand-rolled version.
//
// Keys are the same format the `web-push` CLI uses: base64url of the raw
// uncompressed P-256 public point (65 bytes) and of the raw private scalar `d`
// (32 bytes). Generate a pair with `bun scripts/generate-vapid-keys.ts`.

export interface WebPushEnv {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  FRONTEND_URL: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Language the subscribing browser was reading the app in; the push carries
   *  it back so the service worker renders in the right one. NULL on rows
   *  written before the column existed. */
  locale?: string | null;
}

export type WebPushResult =
  | { ok: true }
  | { ok: false; gone: boolean; status?: number; detail?: string };

const PUSH_TTL_SECONDS = 300; // "you're live" is worthless once the stream is over

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let raw = "";
  for (const b of arr) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function isWebPushConfigured(env: WebPushEnv): boolean {
  return !!env.VAPID_PUBLIC_KEY && !!env.VAPID_PRIVATE_KEY;
}

// VAPID Authorization header: ES256 JWT over {aud, exp, sub} signed with the
// server key, plus the public key for the push service to verify against.
async function vapidAuthHeader(endpoint: string, env: WebPushEnv): Promise<string> {
  const publicBytes = b64urlToBytes(env.VAPID_PUBLIC_KEY!);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(publicBytes.slice(1, 33)),
    y: bytesToB64url(publicBytes.slice(33, 65)),
    d: env.VAPID_PRIVATE_KEY!,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const encoder = new TextEncoder();
  const header = bytesToB64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: env.FRONTEND_URL,
      })
    )
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${header}.${payload}`)
  );

  return `vapid t=${header}.${payload}.${bytesToB64url(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

// RFC 8291 aes128gcm: ECDH against the browser's subscription key, HKDF chain,
// then a single AES-128-GCM record (payload + 0x02 last-record delimiter)
// prefixed by the RFC 8188 header (salt | rs | keyid = our public key).
async function encryptPayload(plaintext: string, sub: PushSubscriptionKeys): Promise<Uint8Array> {
  const uaPublicBytes = b64urlToBytes(sub.p256dh);
  const authSecret = b64urlToBytes(sub.auth);
  const encoder = new TextEncoder();

  const uaPublic = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const localPublicBytes = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  // workers-types renders the ECDH `public` param as `$public`; pass both so
  // the standard runtime name is present either way.
  const ecdhAlg = { name: "ECDH", public: uaPublic, $public: uaPublic } as unknown as Parameters<
    typeof crypto.subtle.deriveBits
  >[0];
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhAlg, local.privateKey, 256));

  const keyInfo = concatBytes(encoder.encode("WebPush: info\0"), uaPublicBytes, localPublicBytes);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const record = concatBytes(encoder.encode(plaintext), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, aesKey, record as BufferSource)
  );

  // Header: salt(16) | record size uint32 BE (4096) | keyid length (65) | keyid
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(localPublicBytes, 21);

  return concatBytes(header, ciphertext);
}

export async function sendWebPush(
  env: WebPushEnv,
  sub: PushSubscriptionKeys,
  payload: Record<string, unknown>
): Promise<WebPushResult> {
  if (!isWebPushConfigured(env)) return { ok: false, gone: false, detail: "vapid_not_configured" };

  try {
    const body = await encryptPayload(JSON.stringify(payload), sub);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthHeader(sub.endpoint, env),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: "high",
      },
      body: body as unknown as BodyInit,
    });

    if (res.ok) return { ok: true };
    // 404/410 = subscription expired or unsubscribed — caller should drop the row.
    const gone = res.status === 404 || res.status === 410;
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, gone, status: res.status, detail };
  } catch (e) {
    return { ok: false, gone: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
