import express from 'express';
import { migrate, pool } from './db.js';
import { loadUser, csrfGuard } from './auth.js';
import routes from './routes.js';
import { lineWebhook, startReminders } from './line.js';
import chatRoutes, { bridgeRouter, startChatJobs } from './chat.js';
import { oauthRouter, wellKnown } from './oauth.js';
import { mcpRouter, aiRouter } from './mcp.js';
import { udidReply } from './udid.js';
import accRoutes, { startAccJobs } from './acc/routes.js';
import locationRoutes, { pingRouter as locationPing } from './location.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
// LINE signs the raw body, so its webhook is read before the JSON parser and the CSRF guard.
app.post('/api/line/webhook', express.raw({ type: '*/*', limit: '1mb' }), lineWebhook);
// iOS posts the UDID profile reply as a signed blob with no CSRF header.
app.post('/api/udid', express.raw({ type: '*/*', limit: '64kb' }), udidReply);
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', async (_req, res) => {
  await pool.query('select 1');
  res.json({ ok: true });
});
// The Mac bridge signs in with its own token (Authorization: Bearer), not the cookie.
app.use('/api/bridge', bridgeRouter);
app.use('/api/chat', loadUser, csrfGuard, chatRoutes);
// Claude / ChatGPT: the MCP server, its OAuth sign-in, and the app's own settings for it.
app.use('/.well-known', wellKnown);
app.use('/mcp', mcpRouter);
app.use('/api/oauth', oauthRouter);
app.use('/api/ai', loadUser, csrfGuard, aiRouter);
// Accounting (account.centel.app): its own router so its public document links skip sign-in.
app.use('/api/acc', loadUser, csrfGuard, accRoutes);
// Partner location: the iOS app posts in the background with its own token, no cookie.
app.use('/api/location/ping', locationPing);
app.use('/api/location', loadUser, csrfGuard, locationRoutes);
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
startReminders();
startChatJobs();
startAccJobs();
