/**
 * Verifies a Kapso webhook signature using the Web Crypto API (Workers-compatible).
 * Kapso sends the signature as "sha256=<hex>" in the X-Webhook-Signature header.
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));

  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (hex.length !== signatureHeader.length) return false;

  // Constant-time comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < hex.length; i++) {
    diff |= hex.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}
