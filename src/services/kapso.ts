import type { Env } from '../index';

const BASE_URL = 'https://api.kapso.ai';

export async function sendWhatsAppMessage(to: string, body: string, env: Env): Promise<void> {
  const url = `${BASE_URL}/meta/whatsapp/v24.0/${env.KAPSO_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-Key': env.KAPSO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kapso send message failed (${response.status}): ${text}`);
  }
}

/**
 * React to an inbound message with an emoji. WhatsApp allows a single reaction
 * per message per sender — sending a new emoji replaces the previous one, and
 * an empty string removes it. Used to signal processing state (🕐 → ✅).
 */
export async function sendReaction(
  to: string,
  messageId: string,
  emoji: string,
  env: Env,
): Promise<void> {
  const url = `${BASE_URL}/meta/whatsapp/v24.0/${env.KAPSO_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-Key': env.KAPSO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: { message_id: messageId, emoji },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kapso send reaction failed (${response.status}): ${text}`);
  }
}
