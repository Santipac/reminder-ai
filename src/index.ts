import { Hono } from 'hono';
import { handleWebhook } from './routes/webhook';
import { runScheduler } from './scheduler/index';

export interface Env {
  KAPSO_API_KEY: string;
  KAPSO_PHONE_NUMBER_ID: string;
  KAPSO_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  DEFAULT_TIMEZONE: string;
  SKIP_WEBHOOK_SIGNATURE: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ status: 'ok' }));
app.post('/webhook', handleWebhook);

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduler(env));
  },
};
