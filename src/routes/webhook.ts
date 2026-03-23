import type { Context } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { reminders } from '../db/schema';
import { parseIntent } from '../services/openai';
import { sendWhatsAppMessage } from '../services/kapso';
import { verifyWebhookSignature } from '../utils/webhook-verify';
import type { Env } from '../index';

interface KapsoMessage {
  id: string;
  type: 'text' | 'audio' | 'image' | 'video' | 'document' | string;
  from: string;
  text?: { body: string };
  audio?: { id: string; voice?: boolean };
  kapso?: {
    direction: 'inbound' | 'outbound';
    content?: string;
    transcript?: { text: string };
    media_url?: string;
  };
}

interface KapsoWebhookPayload {
  message?: KapsoMessage;
  phone_number_id?: string;
  conversation?: { id: string };
}

function formatScheduledAt(isoUtc: string, timezone: string): string {
  return new Date(isoUtc).toLocaleString('es-AR', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

async function getPendingReminders(phone: string, env: Env) {
  const db = getDb(env);
  return db
    .select()
    .from(reminders)
    .where(and(eq(reminders.phone, phone), eq(reminders.status, 'pending')))
    .orderBy(asc(reminders.scheduledAt));
}

async function handleMessage(message: KapsoMessage, env: Env): Promise<void> {
  const phone = message.from;
  let rawText: string;

  if (message.type === 'audio' && message.kapso?.transcript?.text) {
    rawText = message.kapso.transcript.text;
  } else if (message.type === 'text' && message.text?.body) {
    rawText = message.text.body;
  } else {
    await sendWhatsAppMessage(
      phone,
      'Solo puedo procesar mensajes de texto o notas de voz. Enviame un recordatorio como:\n"Recordame mañana a las 10am que tengo turno médico"',
      env,
    );
    return;
  }

  const intent = await parseIntent(rawText, env);

  if (intent.intent === 'list_reminders') {
    const pending = await getPendingReminders(phone, env);

    if (pending.length === 0) {
      await sendWhatsAppMessage(phone, '¡Todo al día! No tenés recordatorios pendientes. ✅', env);
      return;
    }

    const list = pending
      .map((r, i) => `*${i + 1}.* ${formatScheduledAt(r.scheduledAt, env.DEFAULT_TIMEZONE)}\n    📝 ${r.message}`)
      .join('\n\n');

    await sendWhatsAppMessage(
      phone,
      `📋 *Tus recordatorios pendientes:*\n\n${list}\n\nPara eliminar uno escribí, por ejemplo: _"Borrá el 2"_`,
      env,
    );
    return;
  }

  if (intent.intent === 'delete_reminder') {
    const pending = await getPendingReminders(phone, env);
    const toDelete = pending[intent.index - 1];

    if (!toDelete) {
      await sendWhatsAppMessage(
        phone,
        `No encontré el recordatorio número ${intent.index}. Escribí "mis recordatorios" para ver la lista actualizada.`,
        env,
      );
      return;
    }

    const db = getDb(env);
    await db.update(reminders).set({ status: 'cancelled' }).where(eq(reminders.id, toDelete.id));

    await sendWhatsAppMessage(
      phone,
      `🗑️ Recordatorio cancelado:\n📝 ${toDelete.message}\n📅 ${formatScheduledAt(toDelete.scheduledAt, env.DEFAULT_TIMEZONE)}`,
      env,
    );
    return;
  }

  if (intent.intent === 'error') {
    await sendWhatsAppMessage(phone, `No pude entender tu mensaje: ${intent.error}`, env);
    return;
  }

  // create_reminder
  const { scheduledAt, message: reminderText } = intent;
  const db = getDb(env);

  await db.insert(reminders).values({
    phone,
    message: reminderText,
    scheduledAt,
    rawInput: rawText,
    createdAt: new Date().toISOString(),
  });

  await sendWhatsAppMessage(
    phone,
    `✅ Recordatorio guardado!\n\n📅 ${formatScheduledAt(scheduledAt, env.DEFAULT_TIMEZONE)}\n📝 ${reminderText}`,
    env,
  );
}

export async function handleWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const rawBody = await c.req.text();

  if (env.SKIP_WEBHOOK_SIGNATURE !== 'true') {
    const signature = c.req.header('x-webhook-signature');
    if (!signature) return c.json({ error: 'Missing signature' }, 401);

    const valid = await verifyWebhookSignature(rawBody, signature, env.KAPSO_WEBHOOK_SECRET);
    if (!valid) return c.json({ error: 'Invalid signature' }, 401);
  }

  const payload = JSON.parse(rawBody) as KapsoWebhookPayload;

  if (!payload.message || payload.message.kapso?.direction !== 'inbound') {
    return c.json({ ok: true });
  }

  // Process async — return 200 immediately so Kapso doesn't retry
  c.executionCtx.waitUntil(
    handleMessage(payload.message, env).catch((err) => {
      console.error('Error processing message:', err);
      return sendWhatsAppMessage(
        payload.message!.from,
        'Ocurrió un error procesando tu mensaje. Por favor, intentá de nuevo en unos minutos.',
        env,
      ).catch(() => {});
    }),
  );

  return c.json({ ok: true });
}
