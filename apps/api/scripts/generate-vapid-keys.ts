// Generates a VAPID key pair for Web Push in the format src/webpush.ts expects:
// base64url raw uncompressed P-256 public point + base64url private scalar.
//
//   bun scripts/generate-vapid-keys.ts
//
// Run once per environment. The public key is served to browsers via
// /push/vapid-public-key; changing the pair invalidates existing subscriptions
// (clients transparently re-subscribe on their next visit).

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes)
    .toString("base64url");
}

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const privateKey = jwk.d!;

console.log("VAPID key pair generated.\n");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("\nLocal dev: add both lines (plus EVENTSUB_SECRET=<any random string>) to apps/api/.env");
console.log("\nProduction:");
console.log(`  echo '${publicKey}' | wrangler secret put VAPID_PUBLIC_KEY --env production`);
console.log(`  echo '${privateKey}' | wrangler secret put VAPID_PRIVATE_KEY --env production`);
console.log("  openssl rand -hex 32 | wrangler secret put EVENTSUB_SECRET --env production");
