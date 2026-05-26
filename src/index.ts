import { Hono } from 'hono';
import { isBlocked } from './profanity';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  IP_HASH_SALT: string;
  ADMIN_TOKEN: string;
};

// --- decay constants ---------------------------------------------------------
const LIFESPAN = 604800; // 7 days, in seconds
const GRACE = 172800; // 2 days a dead petal lingers as a ghost
const TOTAL = LIFESPAN + GRACE; // beyond this, a petal is soft-deleted

// --- abuse limits ------------------------------------------------------------
const MAX_TEXT = 280;
const PETALS_PER_HOUR = 5;
const REACTIONS_PER_HOUR = 30;
const FLOWERS_PER_HOUR = 3;
const HOUR = 3600;
const DAY = 86400;

// Petal colors, rotated softly. The frontend maps these keys to hues.
const COLORS = ['rose', 'sage', 'lavender', 'gold', 'sky'] as const;

const app = new Hono<{ Bindings: Bindings }>();

// --- helpers -----------------------------------------------------------------

const now = () => Math.floor(Date.now() / 1000);
const uuid = () => crypto.randomUUID();

async function hashIp(ip: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${ip}:${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
}

// aliveness: 1.0 when fresh, easing to 0 across the lifespan.
function aliveness(lastRenewedAt: number, at: number): number {
  return Math.max(0, 1 - (at - lastRenewedAt) / LIFESPAN);
}

type PetalRow = {
  id: string;
  flower_id: string;
  text: string;
  color: string;
  created_at: number;
  last_renewed_at: number;
  reaction_count: number;
};

function shapePetal(p: PetalRow, at: number) {
  const a = aliveness(p.last_renewed_at, at);
  return {
    id: p.id,
    text: p.text,
    color: p.color,
    createdAt: p.created_at,
    aliveness: a,
    // Once aliveness hits zero a petal lingers faintly through the grace window.
    isGhost: a <= 0,
  };
}

// Lazily clear petals that have outlived even their grace period.
async function sweep(db: D1Database, at: number): Promise<void> {
  await db
    .prepare('UPDATE petals SET deleted_at = ? WHERE deleted_at IS NULL AND last_renewed_at < ?')
    .bind(at, at - TOTAL)
    .run();
}

async function rateExceeded(
  db: D1Database,
  ipHash: string,
  action: string,
  limit: number,
  windowSeconds: number,
  at: number,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE ip_hash = ? AND action = ? AND created_at > ?')
    .bind(ipHash, action, at - windowSeconds)
    .first<{ n: number }>();
  return (row?.n ?? 0) >= limit;
}

async function logRate(db: D1Database, ipHash: string, action: string, at: number): Promise<void> {
  await db.prepare('INSERT INTO rate_events (ip_hash, action, created_at) VALUES (?, ?, ?)').bind(ipHash, action, at).run();
}

async function loadFlower(db: D1Database, flowerId: string, at: number) {
  const flower = await db
    .prepare('SELECT id, max_petals, created_at, theme FROM flowers WHERE id = ?')
    .bind(flowerId)
    .first<{ id: string; max_petals: number; created_at: number; theme: string | null }>();
  if (!flower) return null;

  const { results } = await db
    .prepare(
      'SELECT id, flower_id, text, color, created_at, last_renewed_at, reaction_count ' +
        'FROM petals WHERE flower_id = ? AND deleted_at IS NULL AND last_renewed_at >= ? ' +
        'ORDER BY created_at ASC',
    )
    .bind(flowerId, at - TOTAL)
    .all<PetalRow>();

  const petals = (results ?? []).map((p) => shapePetal(p, at));
  return {
    id: flower.id,
    maxPetals: flower.max_petals,
    theme: flower.theme,
    petals,
    hasRoom: petals.length < flower.max_petals,
  };
}

// --- public API --------------------------------------------------------------

app.get('/api/flowers', async (c) => {
  const at = now();
  await sweep(c.env.DB, at);
  const { results } = await c.env.DB.prepare('SELECT id FROM flowers ORDER BY created_at ASC').all<{ id: string }>();
  const flowers = [];
  for (const { id } of results ?? []) {
    const flower = await loadFlower(c.env.DB, id, at);
    if (flower) flowers.push(flower);
  }
  return c.json({ flowers });
});

app.get('/api/flowers/:id', async (c) => {
  const at = now();
  await sweep(c.env.DB, at);
  const flower = await loadFlower(c.env.DB, c.req.param('id'), at);
  if (!flower) return c.json({ message: 'That flower is no longer here.' }, 404);
  return c.json({ flower });
});

app.post('/api/flowers', async (c) => {
  const at = now();
  const ipHash = await hashIp(clientIp(c), c.env.IP_HASH_SALT);
  if (await rateExceeded(c.env.DB, ipHash, 'flower', FLOWERS_PER_HOUR, HOUR, at)) {
    return c.json({ message: 'Rest a moment before planting another.' }, 429);
  }

  const body = await c.req
    .json<{ theme?: string; maxPetals?: number; website?: string }>()
    .catch(() => ({}) as { theme?: string; maxPetals?: number; website?: string });
  if (body.website) return c.json({ message: 'Thank you for that.' }, 200); // honeypot: pretend success

  const theme = typeof body.theme === 'string' ? body.theme.trim().slice(0, 120) || null : null;
  const maxPetals = Math.min(8, Math.max(5, Number(body.maxPetals) || 6));
  const id = uuid();
  await c.env.DB.prepare('INSERT INTO flowers (id, max_petals, created_at, theme) VALUES (?, ?, ?, ?)')
    .bind(id, maxPetals, at, theme)
    .run();
  await logRate(c.env.DB, ipHash, 'flower', at);

  const flower = await loadFlower(c.env.DB, id, at);
  return c.json({ flower }, 201);
});

app.post('/api/flowers/:id/petals', async (c) => {
  const at = now();
  const flowerId = c.req.param('id');
  const ipHash = await hashIp(clientIp(c), c.env.IP_HASH_SALT);

  const body = await c.req
    .json<{ text?: string; website?: string }>()
    .catch(() => ({}) as { text?: string; website?: string });
  // Honeypot: a hidden field humans never fill. Pretend it worked, plant nothing.
  if (body.website) return c.json({ message: 'Thank you for that.' }, 200);

  const text = (body.text ?? '').trim();
  if (!text) return c.json({ message: 'There were no words to leave.' }, 400);
  if (text.length > MAX_TEXT) return c.json({ message: 'That was a little too long to hold.' }, 400);
  if (isBlocked(text)) return c.json({ message: 'Something held it back. Try different words.' }, 422);

  if (await rateExceeded(c.env.DB, ipHash, 'petal', PETALS_PER_HOUR, HOUR, at)) {
    return c.json({ message: 'You have left several already. Come back in a while.' }, 429);
  }

  const flower = await loadFlower(c.env.DB, flowerId, at);
  if (!flower) return c.json({ message: 'That flower is no longer here.' }, 404);
  if (!flower.hasRoom) return c.json({ message: 'This flower is full. Find another.' }, 409);

  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const id = uuid();
  await c.env.DB.prepare(
    'INSERT INTO petals (id, flower_id, text, color, created_at, last_renewed_at, reaction_count) VALUES (?, ?, ?, ?, ?, ?, 0)',
  )
    .bind(id, flowerId, text, color, at, at)
    .run();
  await logRate(c.env.DB, ipHash, 'petal', at);

  return c.json({ petal: shapePetal({ id, flower_id: flowerId, text, color, created_at: at, last_renewed_at: at, reaction_count: 0 }, at) }, 201);
});

app.post('/api/petals/:id/react', async (c) => {
  const at = now();
  const petalId = c.req.param('id');
  const ipHash = await hashIp(clientIp(c), c.env.IP_HASH_SALT);

  if (await rateExceeded(c.env.DB, ipHash, 'react', REACTIONS_PER_HOUR, HOUR, at)) {
    return c.json({ message: 'Let the garden breathe for a moment.' }, 429);
  }

  const petal = await c.env.DB.prepare(
    'SELECT id, flower_id, text, color, created_at, last_renewed_at, reaction_count FROM petals WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(petalId)
    .first<PetalRow>();
  if (!petal) return c.json({ message: 'That petal has already gone.' }, 404);

  // One renewal per petal per person per day.
  const recent = await c.env.DB.prepare(
    'SELECT id FROM reactions WHERE petal_id = ? AND ip_hash = ? AND created_at > ?',
  )
    .bind(petalId, ipHash, at - DAY)
    .first();
  if (recent) {
    // Already kept alive recently; return its current state without renewing again.
    return c.json({ petal: shapePetal(petal, at), alreadyKept: true }, 200);
  }

  await c.env.DB.prepare('INSERT INTO reactions (id, petal_id, ip_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(uuid(), petalId, ipHash, at)
    .run();
  await c.env.DB.prepare('UPDATE petals SET last_renewed_at = ?, reaction_count = reaction_count + 1 WHERE id = ?')
    .bind(at, petalId)
    .run();
  await logRate(c.env.DB, ipHash, 'react', at);

  return c.json({ petal: shapePetal({ ...petal, last_renewed_at: at, reaction_count: petal.reaction_count + 1 }, at) });
});

// --- admin (bearer token) ----------------------------------------------------

app.use('/admin/*', async (c, next) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!c.env.ADMIN_TOKEN || token !== c.env.ADMIN_TOKEN) {
    return c.json({ message: 'Not permitted.' }, 401);
  }
  await next();
});

app.get('/admin/flowers', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT f.id, f.theme, f.max_petals, ' +
      '(SELECT COUNT(*) FROM petals p WHERE p.flower_id = f.id AND p.deleted_at IS NULL) AS petal_count ' +
      'FROM flowers f ORDER BY f.created_at ASC',
  ).all();
  return c.json({ flowers: results });
});

app.delete('/admin/petals/:id', async (c) => {
  await c.env.DB.prepare('UPDATE petals SET deleted_at = ? WHERE id = ?').bind(now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

app.delete('/admin/flowers/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('UPDATE petals SET deleted_at = ? WHERE flower_id = ?').bind(now(), id).run();
  await c.env.DB.prepare('DELETE FROM flowers WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// --- static fallback ---------------------------------------------------------
// Static files are served by the assets runtime before the Worker is reached;
// this only catches client navigations, handing back the single page.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
