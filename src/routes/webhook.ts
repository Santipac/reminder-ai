import type { Context } from 'hono';
import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
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
  from_user_id?: string;
  from_parent_user_id?: string;
  username?: string;
  text?: { body: string };
  audio?: { id: string; voice?: boolean };
  kapso?: {
    direction: 'inbound' | 'outbound';
    content?: string;
    transcript?: { text: string };
    media_url?: string;
    business_scoped_user_id?: string | null;
    parent_business_scoped_user_id?: string | null;
    username?: string | null;
  };
}

interface KapsoWebhookPayload {
  message?: KapsoMessage;
  phone_number_id?: string;
  conversation?: {
    id: string;
    phone_number?: string | null;
    business_scoped_user_id?: string | null;
    parent_business_scoped_user_id?: string | null;
    username?: string | null;
  };
  contact?: {
    wa_id?: string | null;
    phone_number?: string | null;
    business_scoped_user_id?: string | null;
    parent_business_scoped_user_id?: string | null;
    username?: string | null;
  };
}

interface Identity {
  phone: string | null;
  businessScopedUserId: string | null;
  parentBusinessScopedUserId: string | null;
  username: string | null;
}

const PHONE_RE = /^\d{6,20}$/;

function extractIdentity(payload: KapsoWebhookPayload): Identity {
  const msg = payload.message;
  const conv = payload.conversation;
  const contact = payload.contact;

  const rawFrom = msg?.from;
  const fromLooksLikePhone = typeof rawFrom === 'string' && PHONE_RE.test(rawFrom);

  const phone =
    conv?.phone_number ??
    contact?.phone_number ??
    contact?.wa_id ??
    (fromLooksLikePhone ? rawFrom! : null);

  const businessScopedUserId =
    msg?.kapso?.business_scoped_user_id ??
    msg?.from_user_id ??
    conv?.business_scoped_user_id ??
    contact?.business_scoped_user_id ??
    (!fromLooksLikePhone && rawFrom ? rawFrom : null);

  const parentBusinessScopedUserId =
    msg?.kapso?.parent_business_scoped_user_id ??
    msg?.from_parent_user_id ??
    conv?.parent_business_scoped_user_id ??
    contact?.parent_business_scoped_user_id ??
    null;

  const username =
    msg?.kapso?.username ??
    msg?.username ??
    conv?.username ??
    contact?.username ??
    null;

  return { phone, businessScopedUserId, parentBusinessScopedUserId, username };
}

function identityFilter(identity: Identity): SQL | null {
  const parts: SQL[] = [];
  if (identity.businessScopedUserId) {
    parts.push(eq(reminders.businessScopedUserId, identity.businessScopedUserId));
  }
  if (identity.phone) {
    parts.push(eq(reminders.phone, identity.phone));
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return or(...parts)!;
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

async function getPendingReminders(identity: Identity, env: Env) {
  const filter = identityFilter(identity);
  if (!filter) return [];
  const db = getDb(env);
  return db
    .select()
    .from(reminders)
    .where(and(filter, eq(reminders.status, 'pending')))
    .orderBy(asc(reminders.scheduledAt));
}

async function reconcileIdentity(identity: Identity, env: Env): Promise<void> {
  if (!identity.phone || !identity.businessScopedUserId) return;
  const db = getDb(env);
  await db
    .update(reminders)
    .set({
      businessScopedUserId: identity.businessScopedUserId,
      parentBusinessScopedUserId: identity.parentBusinessScopedUserId,
      username: identity.username,
    })
    .where(and(eq(reminders.phone, identity.phone), isNull(reminders.businessScopedUserId)));
}

async function handleMessage(
  message: KapsoMessage,
  identity: Identity,
  env: Env,
): Promise<void> {
  const replyTo = identity.phone;
  if (!replyTo) {
    // Outbound send is still phone-based in Kapso; we can't reply without a phone.
    console.warn('[webhook] Inbound without phone identity — cannot reply yet', {
      bsuid: identity.businessScopedUserId,
      username: identity.username,
    });
    return;
  }

  let rawText: string;

  if (message.type === 'audio' && message.kapso?.transcript?.text) {
    rawText = message.kapso.transcript.text;
  } else if (message.type === 'text' && message.text?.body) {
    rawText = message.text.body;
  } else {
    await sendWhatsAppMessage(
      replyTo,
      'Solo puedo procesar mensajes de texto o notas de voz. Enviame un recordatorio como:\n"Recordame mañana a las 10am que tengo turno médico"',
      env,
    );
    return;
  }

  await reconcileIdentity(identity, env);

  const intent = await parseIntent(rawText, env);

  if (intent.intent === 'list_reminders') {
    const pending = await getPendingReminders(identity, env);

    if (pending.length === 0) {
      await sendWhatsAppMessage(replyTo, '¡Todo al día! No tenés recordatorios pendientes. ✅', env);
      return;
    }

    const list = pending
      .map((r, i) => `*${i + 1}.* ${formatScheduledAt(r.scheduledAt, env.DEFAULT_TIMEZONE)}\n    📝 ${r.message}`)
      .join('\n\n');

    await sendWhatsAppMessage(
      replyTo,
      `📋 *Tus recordatorios pendientes:*\n\n${list}\n\nPara eliminar uno escribí, por ejemplo: _"Borrá el 2"_`,
      env,
    );
    return;
  }

  if (intent.intent === 'delete_reminder') {
    const pending = await getPendingReminders(identity, env);
    const toDelete = pending[intent.index - 1];

    if (!toDelete) {
      await sendWhatsAppMessage(
        replyTo,
        `No encontré el recordatorio número ${intent.index}. Escribí "mis recordatorios" para ver la lista actualizada.`,
        env,
      );
      return;
    }

    const db = getDb(env);
    await db.update(reminders).set({ status: 'cancelled' }).where(eq(reminders.id, toDelete.id));

    await sendWhatsAppMessage(
      replyTo,
      `🗑️ Recordatorio cancelado:\n📝 ${toDelete.message}\n📅 ${formatScheduledAt(toDelete.scheduledAt, env.DEFAULT_TIMEZONE)}`,
      env,
    );
    return;
  }

  if (intent.intent === 'error') {
    await sendWhatsAppMessage(replyTo, `No pude entender tu mensaje: ${intent.error}`, env);
    return;
  }

  // create_reminder
  const { scheduledAt, message: reminderText } = intent;
  const db = getDb(env);

  await db.insert(reminders).values({
    phone: identity.phone,
    businessScopedUserId: identity.businessScopedUserId,
    parentBusinessScopedUserId: identity.parentBusinessScopedUserId,
    username: identity.username,
    message: reminderText,
    scheduledAt,
    rawInput: rawText,
    createdAt: new Date().toISOString(),
  });

  await sendWhatsAppMessage(
    replyTo,
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

  const identity = extractIdentity(payload);
  const message = payload.message;

  // Process async — return 200 immediately so Kapso doesn't retry
  c.executionCtx.waitUntil(
    handleMessage(message, identity, env).catch((err) => {
      console.error('Error processing message:', err);
      if (!identity.phone) return;
      return sendWhatsAppMessage(
        identity.phone,
        'Ocurrió un error procesando tu mensaje. Por favor, intentá de nuevo en unos minutos.',
        env,
      ).catch(() => {});
    }),
  );

  return c.json({ ok: true });
}
