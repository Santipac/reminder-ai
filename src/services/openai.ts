import OpenAI from 'openai';
import type { Env } from '../index';

export type IntentResult =
  | { intent: 'create_reminder'; scheduledAt: string; message: string }
  | { intent: 'list_reminders' }
  | { intent: 'delete_reminder'; index: number }
  | { intent: 'error'; error: string };

function localToUTC(localISO: string, timezone: string): string {
  const approxUTC = new Date(localISO + 'Z');

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(approxUTC);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');

  const tzAsUTC = new Date(
    Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')),
  );

  const offsetMs = approxUTC.getTime() - tzAsUTC.getTime();
  return new Date(approxUTC.getTime() + offsetMs).toISOString();
}

export async function parseIntent(userInput: string, env: Env): Promise<IntentResult> {
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const now = new Date();

  const localDateStr = now.toLocaleDateString('en-CA', { timeZone: env.DEFAULT_TIMEZONE });
  const localTimeStr = now.toLocaleTimeString('en-GB', {
    timeZone: env.DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const in2MinLocal = new Date(now.getTime() + 2 * 60000).toLocaleTimeString('en-GB', {
    timeZone: env.DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const systemPrompt = `Sos un asistente de recordatorios. Analizá el mensaje del usuario y determiná su intención.

Fecha y hora actual del usuario: ${localDateStr} ${localTimeStr} (zona: ${env.DEFAULT_TIMEZONE})

Intenciones posibles:
1. "create_reminder": El usuario quiere crear un recordatorio.
2. "list_reminders": El usuario quiere ver sus recordatorios pendientes (ej: "mostrame mis recordatorios", "qué recordatorios tengo", "listar", "mis recordatorios").
3. "delete_reminder": El usuario quiere eliminar un recordatorio por número (ej: "eliminá el 2", "borrar el 3", "cancelar el número 1", "borrá el primero").
4. "error": El mensaje no es ninguna de las intenciones anteriores o no se puede interpretar.

Reglas para "create_reminder":
- "mañana" = ${new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: env.DEFAULT_TIMEZONE })}
- "mediodía" / "noon" = 12:00, "medianoche" / "midnight" = 00:00
- "pasado mañana" = en 2 días
- "en X minutos/horas" = sumar X a la hora actual local
- Sin hora → asumir 09:00. Sin fecha → asumir hoy.
- "scheduledAt" debe ser la hora LOCAL en formato ISO sin zona horaria (ej: "2026-03-23T09:00:00")
- "message" = solo el contenido del recordatorio, sin frases temporales, en el idioma del usuario
- Ejemplo "en 2 minutos" → scheduledAt: "${localDateStr}T${in2MinLocal}:00"

Retornar SOLO JSON:

Para create_reminder:
{"intent":"create_reminder","scheduledAt":"<YYYY-MM-DDTHH:mm:ss>","message":"<texto>"}

Para list_reminders:
{"intent":"list_reminders"}

Para delete_reminder:
{"intent":"delete_reminder","index":<número entero>}

Para error:
{"intent":"error","error":"<explicación en el idioma del usuario>"}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 256,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput },
    ],
  });

  const rawText = response.choices[0]?.message?.content ?? '';

  let result: { intent: string; scheduledAt?: string; message?: string; index?: number; error?: string };
  try {
    result = JSON.parse(rawText);
  } catch {
    return {
      intent: 'error',
      error: 'No pude interpretar tu mensaje. Intentá con algo como: "Recordame mañana a las 3pm llamar al médico"',
    };
  }

  if (result.intent === 'create_reminder') {
    if (!result.scheduledAt || !result.message) {
      return { intent: 'error', error: result.error ?? 'No pude crear el recordatorio.' };
    }
    return {
      intent: 'create_reminder',
      scheduledAt: localToUTC(result.scheduledAt, env.DEFAULT_TIMEZONE),
      message: result.message,
    };
  }

  if (result.intent === 'list_reminders') {
    return { intent: 'list_reminders' };
  }

  if (result.intent === 'delete_reminder') {
    if (typeof result.index !== 'number' || result.index < 1) {
      return {
        intent: 'error',
        error: 'No pude determinar qué recordatorio eliminar. Decime el número. Ej: "Borrá el 2"',
      };
    }
    return { intent: 'delete_reminder', index: result.index };
  }

  return { intent: 'error', error: result.error ?? 'No entendí tu mensaje.' };
}

export async function generatePersonalizedReminder(message: string, env: Env): Promise<string> {
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const systemPrompt = `Sos un asistente que envía recordatorios por WhatsApp.
Tu tarea es redactar un aviso corto y cercano (1-2 oraciones) que deje clarísimo QUÉ tiene que hacer la persona, con un toque personal sin alejarse del tema.

Reglas:
- Priorizá la claridad: la acción debe entenderse al instante; nada de metáforas, juegos de palabras o frases que suenen a eslogan
- Podés reformular el recordatorio ("Recordá...", "Es hora de...", "No olvides...") y sumar una razón breve cuando ayude (evitar problemas, estar al día, cuidar la salud)
- Cero o como mucho un emoji, solo si aporta algo; no decores el mensaje
- Tono de mensaje de un conocido, pero directo; no inventes tareas que no estén en el recordatorio

Ejemplos:
- "leer" → "Recordá leer un rato; te ayuda a despejar la cabeza."
- "ir al supermercado" → "Es hora de ir al supermercado, así no te faltan cosas."
- "turno médico" → "No olvides el turno médico; mejor ir al día con la salud."
- "llamar a mamá" → "Llamá a mamá cuando puedas, seguro le alegra."
- "tomar medicación" → "Recordá tomar la medicación ahora, es importante hacerlo a tiempo."
- "pagar factura" → "Recordá pagar la factura para evitar problemas o recargos."
- "reunión" → "Te toca la reunión; entrá puntual para no perder nada de lo que se habla."

Respondé ÚNICAMENTE con el mensaje, sin comillas, sin explicaciones adicionales.`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ?? `🔔 Recordatorio: ${message}`;
  } catch {
    return `🔔 Recordatorio: ${message}`;
  }
}
