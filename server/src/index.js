import express from 'express';
import { migrate, pool } from './db.js';
import { loadUser, csrfGuard } from './auth.js';
import routes from './routes.js';
import { lineWebhook, startLineReminders } from './line.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
// LINE signs the raw body, so its webhook is read before the JSON parser and the CSRF guard.
app.post('/api/line/webhook', express.raw({ type: '*/*', limit: '1mb' }), lineWebhook);
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', async (_req, res) => {
  await pool.query('select 1');
  res.json({ ok: true });
});
app.use('/api', loadUser, csrfGuard, routes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// Workflow functions raise named errors (P0001/P0002); RLS refusals are 42501.
app.use((err, _req, res, _next) => {
  if (err.expose) return res.status(err.status || 400).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  if (err.code === 'P0001') return res.status(409).json({ error: err.message });
  if (err.code === 'P0002') return res.status(404).json({ error: 'not_found' });
  if (err.code === '42501') return res.status(403).json({ error: 'forbidden' });
  if (err.code === '23505') return res.status(409).json({ error: 'conflict' });
  if (err.code === '22P02' || err.code === '23514') return res.status(400).json({ error: 'bad_request' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

const port = Number(process.env.PORT || 3000);
await migrate();
app.listen(port, () => console.log(`centel api on :${port}`));
startLineReminders();
