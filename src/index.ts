import { Hono } from 'hono';
import { isBlocked, hasLink } from './profanity';

type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  IMAGES: R2Bucket;
  IP_HASH_SALT: string;
  ADMIN_TOKEN: string;
};

// --- decay constants ---------------------------------------------------------
const LIFESPAN = 604800; // 7 days, in seconds; aliveness eases to 0 across this
// Expired petals are not removed; they linger, wilted and unreadable, until renewed.

// --- abuse limits ------------------------------------------------------------
const MIN_TEXT = 2;
const MAX_TEXT = 280;
const PETALS_PER_HOUR = 5;
const REACTIONS_PER_HOUR = 30;
const FLOWERS_PER_HOUR = 3;
const UPLOADS_PER_HOUR = 12;
const COMMENTS_PER_HOUR = 12;
const REPORTS_PER_HOUR = 20;
const MAX_COMMENT = 280;
const HOUR = 3600;
const DAY = 86400;

// Images petals may carry. Kept small; the browser downscales before upload.
const MAX_IMAGE_BYTES = 2_000_000;
const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const IMAGE_KEY = /^[A-Za-z0-9-]+\.(jpg|png|gif|webp)$/;

// Petal colors, rotated softly. The frontend maps these keys to hues.
const COLORS = ['rose', 'sage', 'lavender', 'gold', 'sky'] as const;

// Optional context a note may carry. Values are validated against these sets;
// anything unrecognized is simply dropped.
const MEDIUMS = new Set(['in_person', 'text', 'call', 'video', 'email', 'letter', 'other']);
const DIRECTIONS = new Set(['gave', 'received']);
const RELATIONSHIPS = new Set([
  'mother', 'father', 'daughter', 'son', 'sister', 'brother',
  'wife', 'husband', 'partner', 'grandmother', 'grandfather',
  'friend', 'stranger', 'myself', 'someone_else',
]);

function clean(value: unknown, allowed: Set<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

// Gentle themes for flowers the garden grows on its own when all others are full.
const THEMES = [
  'what are you carrying?',
  'what would you forgive?',
  'what are you grateful for?',
  'what did you never get to say?',
  'what do you hope for?',
  'what are you letting go of?',
  null,
];

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
  spoken_at: number;
  medium: string | null;
  direction: string | null;
  relationship: string | null;
  image_id: string | null;
  last_renewed_at: number;
  reaction_count: number;
  comment_count?: number;
};

function shapePetal(p: PetalRow, at: number) {
  const a = aliveness(p.last_renewed_at, at);
  return {
    id: p.id,
    text: p.text,
    color: p.color,
    createdAt: p.created_at,
    spokenAt: p.spoken_at,
    medium: p.medium,
    direction: p.direction,
    relationship: p.relationship,
    imageUrl: p.image_id ? `/i/${p.image_id}` : null,
    reactionCount: p.reaction_count,
    commentCount: p.comment_count ?? 0,
    aliveness: a,
    // Once aliveness hits zero the petal has expired: it stays on the flower,
    // wilted, its words no longer legible, until a reaction brings it back.
    expired: a <= 0,
  };
}

const PETAL_COLUMNS =
  'id, flower_id, text, color, created_at, spoken_at, medium, direction, relationship, image_id, last_renewed_at, reaction_count';

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

  // Expired petals are kept (they linger, wilted), so there is no time filter.
  const { results } = await db
    .prepare(
      `SELECT ${PETAL_COLUMNS}, (SELECT COUNT(*) FROM comments c WHERE c.petal_id = petals.id AND c.deleted_at IS NULL) AS comment_count ` +
        `FROM petals WHERE flower_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    )
    .bind(flowerId)
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

// The garden keeps at least one flower with room, growing a fresh one
// (no rate limit, this is the garden's own doing) whenever all are full.
async function ensureOpenFlower(db: D1Database, at: number): Promise<void> {
  const { results } = await db.prepare('SELECT id, max_petals FROM flowers').all<{ id: string; max_petals: number }>();
  for (const f of results ?? []) {
    // Expired petals keep their slot, so they count toward a flower being full.
    const row = await db
      .prepare('SELECT COUNT(*) AS n FROM petals WHERE flower_id = ? AND deleted_at IS NULL')
      .bind(f.id)
      .first<{ n: number }>();
    if ((row?.n ?? 0) < f.max_petals) return; // a flower still has room
  }
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  await db
    .prepare('INSERT INTO flowers (id, max_petals, created_at, theme) VALUES (?, ?, ?, ?)')
    .bind(uuid(), 6, at, theme)
    .run();
}

// When a note is removed (or restored), re-pack the living petals so flowers
// fill from the oldest forward: every flower full except the last, open one.
// Emptied flowers are removed (their long-gone petals are first reattached to
// the oldest flower, to satisfy the foreign key); the oldest flower always stays.
async function compactFlowers(db: D1Database, at: number): Promise<void> {
  const flowers =
    (await db.prepare('SELECT id, max_petals FROM flowers ORDER BY created_at ASC').all<{ id: string; max_petals: number }>())
      .results ?? [];
  if (flowers.length === 0) {
    await ensureOpenFlower(db, at);
    return;
  }
  const petals =
    (
      await db
        .prepare('SELECT id, flower_id FROM petals WHERE deleted_at IS NULL ORDER BY created_at ASC')
        .all<{ id: string; flower_id: string }>()
    ).results ?? [];

  // A restore can push past the current capacity; grow new flowers to fit.
  let capacity = flowers.reduce((sum, f) => sum + f.max_petals, 0);
  let extra = 0;
  while (capacity < petals.length) {
    const id = uuid();
    const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
    await db.prepare('INSERT INTO flowers (id, max_petals, created_at, theme) VALUES (?, 6, ?, ?)').bind(id, at + ++extra, theme).run();
    flowers.push({ id, max_petals: 6 });
    capacity += 6;
  }

  // Fill flowers front-to-back, recording where each petal should move.
  const counts = new Array<number>(flowers.length).fill(0);
  const moves: { id: string; flowerId: string }[] = [];
  let fi = 0;
  for (const p of petals) {
    while (fi < flowers.length && counts[fi] >= flowers[fi].max_petals) fi++;
    if (fi >= flowers.length) break;
    counts[fi]++;
    if (p.flower_id !== flowers[fi].id) moves.push({ id: p.id, flowerId: flowers[fi].id });
  }

  // Keep flowers up to and including the single open one; drop the empties after.
  let lastNeeded = -1;
  for (let i = 0; i < flowers.length; i++) if (counts[i] > 0) lastNeeded = i;
  let keepUntil: number;
  if (lastNeeded === -1) keepUntil = 0;
  else if (counts[lastNeeded] >= flowers[lastNeeded].max_petals) keepUntil = Math.min(lastNeeded + 1, flowers.length - 1);
  else keepUntil = lastNeeded;

  const survivor = flowers[0].id;
  const stmts: D1PreparedStatement[] = [];
  for (const m of moves) {
    stmts.push(db.prepare('UPDATE petals SET flower_id = ? WHERE id = ?').bind(m.flowerId, m.id));
  }
  for (let i = keepUntil + 1; i < flowers.length; i++) {
    stmts.push(db.prepare('UPDATE petals SET flower_id = ? WHERE flower_id = ?').bind(survivor, flowers[i].id));
    stmts.push(db.prepare('DELETE FROM flowers WHERE id = ?').bind(flowers[i].id));
  }
  if (stmts.length) await db.batch(stmts);

  await ensureOpenFlower(db, at);
}

app.get('/api/flowers', async (c) => {
  const at = now();
  await ensureOpenFlower(c.env.DB, at);
  const { results } = await c.env.DB.prepare('SELECT id FROM flowers ORDER BY created_at ASC').all<{ id: string }>();
  const flowers = [];
  for (const { id } of results ?? []) {
    const flower = await loadFlower(c.env.DB, id, at);
    if (flower) flowers.push(flower);
  }
  return c.json({ flowers });
});

// Presence: a heartbeat per visitor. A visitor's fish lingers after they go,
// for a multiple of how long they stayed (clamped), so the pond feels alive.
// Keyed by a salted hash of the IP so the count can't be inflated and the
// table stays bounded (one row per visitor, not per random token).
const PRESENCE_MULT = 3; // a fish lingers this many times the visit length
const PRESENCE_MIN = 60; // ...but at least this long after the last heartbeat
const PRESENCE_MAX = 1800; // ...and at most this long (30 minutes)
app.post('/api/presence', async (c) => {
  const at = now();
  const id = await hashIp(clientIp(c), c.env.IP_HASH_SALT);
  const existing = await c.env.DB.prepare('SELECT first_seen FROM presence WHERE id = ?').bind(id).first<{ first_seen: number }>();
  const firstSeen = existing?.first_seen ?? at;
  const linger = Math.min(Math.max((at - firstSeen) * PRESENCE_MULT, PRESENCE_MIN), PRESENCE_MAX);
  await c.env.DB.prepare('INSERT OR REPLACE INTO presence (id, first_seen, linger_until) VALUES (?, ?, ?)')
    .bind(id, firstSeen, at + linger)
    .run();
  await c.env.DB.prepare('DELETE FROM presence WHERE linger_until < ?').bind(at).run();
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM presence').first<{ n: number }>();
  return c.json({ count: Math.min(row?.n ?? 1, 99) });
});

// Aggregate, never personal: a quiet sense of the whole garden's weather.
app.get('/api/stats', async (c) => {
  const at = now();
  const db = c.env.DB;
  const alive = await db
    .prepare('SELECT COUNT(*) AS n FROM petals WHERE deleted_at IS NULL AND last_renewed_at >= ?')
    .bind(at - LIFESPAN)
    .first<{ n: number }>();
  const flowers = await db.prepare('SELECT COUNT(*) AS n FROM flowers').first<{ n: number }>();
  const kept = await db.prepare('SELECT COALESCE(SUM(reaction_count), 0) AS n FROM petals').first<{ n: number }>();
  const faded = await db
    .prepare('SELECT COUNT(*) AS n FROM petals WHERE deleted_at IS NULL AND last_renewed_at < ?')
    .bind(at - LIFESPAN)
    .first<{ n: number }>();
  const oldest = await db
    .prepare('SELECT MIN(spoken_at) AS t FROM petals WHERE deleted_at IS NULL')
    .first<{ t: number | null }>();

  return c.json({
    stats: {
      petalsAlive: alive?.n ?? 0,
      flowers: flowers?.n ?? 0,
      keptAlive: kept?.n ?? 0,
      faded: faded?.n ?? 0,
      oldestSpokenAt: oldest?.t ?? null,
    },
  });
});

app.get('/api/flowers/:id', async (c) => {
  const at = now();
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
    .json<{
      text?: string;
      website?: string;
      spokenAt?: number;
      medium?: string;
      direction?: string;
      relationship?: string;
      imageId?: string;
    }>()
    .catch(() => ({}) as Record<string, unknown>);
  // Honeypot: a hidden field humans never fill. Pretend it worked, plant nothing.
  if ((body as { website?: string }).website) return c.json({ message: 'Thank you for that.' }, 200);

  const text = ((body as { text?: string }).text ?? '').trim();
  if (text.length < MIN_TEXT) return c.json({ message: 'A few more words, perhaps.' }, 400);
  if (text.length > MAX_TEXT) return c.json({ message: 'That was a little too long to hold.' }, 400);
  if (isBlocked(text)) return c.json({ message: 'Something held it back. Try different words.' }, 422);
  if (hasLink(text)) return c.json({ message: 'This is a place for words, not links.' }, 422);

  // When the words were first said. Defaults to today; one may reach back, never forward.
  let spokenAt = Number((body as { spokenAt?: number }).spokenAt);
  if (!Number.isFinite(spokenAt)) spokenAt = at;
  spokenAt = Math.min(Math.max(Math.floor(spokenAt), 0), at);

  // Optional, gently held context. Unknown values are dropped.
  const medium = clean((body as { medium?: unknown }).medium, MEDIUMS);
  const direction = clean((body as { direction?: unknown }).direction, DIRECTIONS);
  const relationship = clean((body as { relationship?: unknown }).relationship, RELATIONSHIPS);
  const imageRaw = (body as { imageId?: unknown }).imageId;
  const imageId = typeof imageRaw === 'string' && IMAGE_KEY.test(imageRaw) ? imageRaw : null;

  if (await rateExceeded(c.env.DB, ipHash, 'petal', PETALS_PER_HOUR, HOUR, at)) {
    return c.json({ message: 'You have left several already. Come back in a while.' }, 429);
  }

  const flower = await loadFlower(c.env.DB, flowerId, at);
  if (!flower) return c.json({ message: 'That flower is no longer here.' }, 404);
  if (!flower.hasRoom) return c.json({ message: 'This flower is full. Find another.' }, 409);

  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const id = uuid();
  await c.env.DB.prepare(
    'INSERT INTO petals (id, flower_id, text, color, created_at, spoken_at, medium, direction, relationship, image_id, last_renewed_at, reaction_count) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
  )
    .bind(id, flowerId, text, color, at, spokenAt, medium, direction, relationship, imageId, at)
    .run();
  await logRate(c.env.DB, ipHash, 'petal', at);

  return c.json(
    {
      petal: shapePetal(
        {
          id,
          flower_id: flowerId,
          text,
          color,
          created_at: at,
          spoken_at: spokenAt,
          medium,
          direction,
          relationship,
          image_id: imageId,
          last_renewed_at: at,
          reaction_count: 0,
        },
        at,
      ),
    },
    201,
  );
});

// Receive one downscaled image, store it in R2, return its key.
app.post('/api/upload', async (c) => {
  const at = now();
  const ipHash = await hashIp(clientIp(c), c.env.IP_HASH_SALT);
  if (await rateExceeded(c.env.DB, ipHash, 'upload', UPLOADS_PER_HOUR, HOUR, at)) {
    return c.json({ message: 'That is a lot of images for now. Come back in a while.' }, 429);
  }

  const contentType = (c.req.header('content-type') || '').split(';')[0].trim();
  const ext = IMAGE_TYPES[contentType];
  if (!ext) return c.json({ message: 'That kind of file cannot be left here.' }, 415);

  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) return c.json({ message: 'The image was empty.' }, 400);
  if (buf.byteLength > MAX_IMAGE_BYTES) return c.json({ message: 'That image is a little too large.' }, 413);

  const key = `${uuid()}.${ext}`;
  await c.env.IMAGES.put(key, buf, { httpMetadata: { contentType } });
  await logRate(c.env.DB, ipHash, 'upload', at);
  return c.json({ id: key }, 201);
});

// Serve a stored image.
app.get('/i/:key', async (c) => {
  const key = c.req.param('key');
  if (!IMAGE_KEY.test(key)) return c.notFound();
  const obj = await c.env.IMAGES.get(key);
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      etag: obj.httpEtag,
    },
  });
});

app.post('/api/petals/:id/react', async (c) => {
  const at = now();
  const petalId = c.req.param('id');
  const ipHash = await hashIp(clientIp(c), c.env.IP_HASH_SALT);

  if (await rateExceeded(c.env.DB, ipHash, 'react', REACTIONS_PER_HOUR, HOUR, at)) {
    return c.json({ message: 'Let the garden breathe for a moment.' }, 429);
  }

  const petal = await c.env.DB.prepare(
    `SELECT ${PETAL_COLUMNS}, (SELECT COUNT(*) FROM comments c WHERE c.petal_id = petals.id AND c.deleted_at IS NULL) AS comment_count ` +
      `FROM petals WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(petalId)
    .first<PetalRow>();
  if (!petal) return c.json({ message: 'That petal has already gone.' }, 404);

  // Once a petal has expired, it cannot be brought back.
  if (aliveness(petal.last_renewed_at, at) <= 0) {
    return c.json({ message: 'These words have faded for good.' }, 410);
  }

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

// Anonymous replies left on a petal.
app.get('/api/petals/:id/comments', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, text, created_at FROM comments WHERE petal_id = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 200',
  )
    .bind(c.req.param('id'))
    .all<{ id: string; text: string; created_at: number }>();
  const comments = (results ?? []).map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at }));
  return c.json({ comments });
});

app.post('/api/petals/:id/comments', async (c) => {
  const at = now();
  const petalId = c.req.param('id');
  const ipHash = await hashIp(clientIp(c), c.env.IP_HASH_SALT);

  const body = await c.req
    .json<{ text?: string; website?: string }>()
    .catch(() => ({}) as { text?: string; website?: string });
  if (body.website) return c.json({ message: 'Thank you for that.' }, 200); // honeypot

  const text = (body.text ?? '').trim();
  if (!text) return c.json({ message: 'There were no words to leave.' }, 400);
  if (text.length > MAX_COMMENT) return c.json({ message: 'That reply was a little too long.' }, 400);
  if (isBlocked(text)) return c.json({ message: 'Something held it back. Try different words.' }, 422);
  if (hasLink(text)) return c.json({ message: 'This is a place for words, not links.' }, 422);

  if (await rateExceeded(c.env.DB, ipHash, 'comment', COMMENTS_PER_HOUR, HOUR, at)) {
    return c.json({ message: 'You have replied to a few already. Come back in a while.' }, 429);
  }

  const petal = await c.env.DB.prepare('SELECT last_renewed_at FROM petals WHERE id = ? AND deleted_at IS NULL')
    .bind(petalId)
    .first<{ last_renewed_at: number }>();
  if (!petal) return c.json({ message: 'That petal has already gone.' }, 404);
  if (aliveness(petal.last_renewed_at, at) <= 0) return c.json({ message: 'These words have faded for good.' }, 410);

  const id = uuid();
  await c.env.DB.prepare('INSERT INTO comments (id, petal_id, text, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, petalId, text, ipHash, at)
    .run();
  await logRate(c.env.DB, ipHash, 'comment', at);
  return c.json({ comment: { id, text, createdAt: at } }, 201);
});

// A quiet flag on a note or reply, for the keeper to review.
app.post('/api/report', async (c) => {
  const at = now();
  const ipHash = await hashIp(clientIp(c), c.env.IP_HASH_SALT);
  const body = await c.req
    .json<{ type?: string; id?: string }>()
    .catch(() => ({}) as { type?: string; id?: string });
  const type = body.type === 'comment' ? 'comment' : body.type === 'petal' ? 'petal' : null;
  const id = typeof body.id === 'string' ? body.id : '';
  if (!type || !id) return c.json({ message: 'Nothing to flag.' }, 400);

  if (await rateExceeded(c.env.DB, ipHash, 'report', REPORTS_PER_HOUR, HOUR, at)) {
    return c.json({ message: 'Thank you. We will look.' }, 200);
  }
  // One flag per person per target.
  const seen = await c.env.DB.prepare('SELECT id FROM reports WHERE target_type = ? AND target_id = ? AND ip_hash = ?')
    .bind(type, id, ipHash)
    .first();
  if (!seen) {
    await c.env.DB.prepare('INSERT INTO reports (id, target_type, target_id, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(uuid(), type, id, ipHash, at)
      .run();
    await logRate(c.env.DB, ipHash, 'report', at);
  }
  return c.json({ message: 'Thank you. We will look.' }, 200);
});

// --- admin (bearer token) ----------------------------------------------------

// A friendlier path to the review page. Registered before the gate so the
// login form itself loads; it does nothing without the password.
app.get('/admin', (c) => c.env.ASSETS.fetch(new Request(new URL('/admin.html', c.req.url).toString(), c.req.raw)));

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
  const at = now();
  await c.env.DB.prepare('UPDATE petals SET deleted_at = ? WHERE id = ?').bind(at, c.req.param('id')).run();
  // Removing a note frees its slot; re-pack so the flowers stay filled.
  await compactFlowers(c.env.DB, at);
  return c.json({ ok: true });
});

app.delete('/admin/comments/:id', async (c) => {
  await c.env.DB.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').bind(now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

// A whole picture of the garden for the keeper: the counts that show how the
// place is being used, every note with its engagement, and the flagged replies.
app.get('/admin/overview', async (c) => {
  const at = now();
  const db = c.env.DB;
  const live = at - LIFESPAN;

  const one = async (sql: string, ...binds: number[]) =>
    (await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;

  const stats = {
    notes: await one('SELECT COUNT(*) AS n FROM petals WHERE deleted_at IS NULL'),
    alive: await one('SELECT COUNT(*) AS n FROM petals WHERE deleted_at IS NULL AND last_renewed_at >= ?', live),
    faded: await one('SELECT COUNT(*) AS n FROM petals WHERE deleted_at IS NULL AND last_renewed_at < ?', live),
    removed: await one('SELECT COUNT(*) AS n FROM petals WHERE deleted_at IS NOT NULL'),
    flowers: await one('SELECT COUNT(*) AS n FROM flowers'),
    revivals: await one('SELECT COALESCE(SUM(reaction_count), 0) AS n FROM petals WHERE deleted_at IS NULL'),
    replies: await one('SELECT COUNT(*) AS n FROM comments WHERE deleted_at IS NULL'),
    flaggedItems: await one('SELECT COUNT(*) AS n FROM (SELECT 1 FROM reports GROUP BY target_type, target_id)'),
    flags: await one('SELECT COUNT(*) AS n FROM reports'),
    mostRevived: await one('SELECT COALESCE(MAX(reaction_count), 0) AS n FROM petals WHERE deleted_at IS NULL'),
  };
  const oldest = (await db.prepare('SELECT MIN(spoken_at) AS t FROM petals WHERE deleted_at IS NULL').first<{ t: number | null }>())
    ?.t ?? null;

  const { results } = await db
    .prepare(
      `SELECT ${PETAL_COLUMNS}, deleted_at,
         (SELECT COUNT(*) FROM comments cm WHERE cm.petal_id = petals.id AND cm.deleted_at IS NULL) AS comment_count,
         (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'petal' AND r.target_id = petals.id) AS report_count
       FROM petals ORDER BY created_at DESC LIMIT 1000`,
    )
    .all<PetalRow & { deleted_at: number | null; comment_count: number; report_count: number }>();

  // Every reply, grouped under its note, so the keeper can read and remove any
  // of them, not only the flagged ones. Removed replies are kept so they can be restored.
  const allComments =
    (
      await db
        .prepare(
          `SELECT c.id, c.petal_id, c.text, c.created_at, c.deleted_at,
             (SELECT COUNT(*) FROM reports r WHERE r.target_type = 'comment' AND r.target_id = c.id) AS report_count
           FROM comments c ORDER BY c.created_at ASC LIMIT 4000`,
        )
        .all<{ id: string; petal_id: string; text: string; created_at: number; deleted_at: number | null; report_count: number }>()
    ).results ?? [];
  const repliesByPetal = new Map<string, { id: string; text: string; createdAt: number; removed: boolean; reportCount: number }[]>();
  for (const cm of allComments) {
    const arr = repliesByPetal.get(cm.petal_id) ?? [];
    arr.push({ id: cm.id, text: cm.text, createdAt: cm.created_at, removed: cm.deleted_at != null, reportCount: cm.report_count });
    repliesByPetal.set(cm.petal_id, arr);
  }

  const notes = (results ?? []).map((p) => ({
    ...shapePetal(p, at),
    removed: p.deleted_at != null,
    commentCount: p.comment_count,
    reportCount: p.report_count,
    comments: repliesByPetal.get(p.id) ?? [],
  }));

  const reportedComments = allComments
    .filter((c) => c.report_count > 0)
    .map((r) => ({
      id: r.id,
      text: r.text,
      createdAt: r.created_at,
      removed: r.deleted_at != null,
      petalId: r.petal_id,
      reportCount: r.report_count,
    }));

  return c.json({ stats: { ...stats, oldestSpokenAt: oldest }, notes, reportedComments });
});

// The review queue: flagged notes and replies, with their words and counts.
app.get('/admin/reports', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT target_type, target_id, COUNT(*) AS count, MAX(created_at) AS last ' +
      'FROM reports GROUP BY target_type, target_id ORDER BY last DESC LIMIT 200',
  ).all<{ target_type: string; target_id: string; count: number; last: number }>();

  const items = [];
  for (const r of results ?? []) {
    const table = r.target_type === 'comment' ? 'comments' : 'petals';
    const row = await c.env.DB.prepare(`SELECT text, deleted_at FROM ${table} WHERE id = ?`)
      .bind(r.target_id)
      .first<{ text: string; deleted_at: number | null }>();
    items.push({
      type: r.target_type,
      id: r.target_id,
      count: r.count,
      lastReportedAt: r.last,
      text: row ? row.text : '(gone)',
      removed: row ? row.deleted_at != null : true,
    });
  }
  return c.json({ reports: items });
});

// Clear the flags on a target (reviewed, keeping it).
app.delete('/admin/reports/:type/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM reports WHERE target_type = ? AND target_id = ?')
    .bind(c.req.param('type'), c.req.param('id'))
    .run();
  return c.json({ ok: true });
});

// Restore a wrongly-removed note or reply.
app.post('/admin/restore/:type/:id', async (c) => {
  const at = now();
  const isComment = c.req.param('type') === 'comment';
  const table = isComment ? 'comments' : 'petals';
  await c.env.DB.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).bind(c.req.param('id')).run();
  // A restored note needs a slot again; re-pack to make room for it.
  if (!isComment) await compactFlowers(c.env.DB, at);
  return c.json({ ok: true });
});

app.delete('/admin/flowers/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('UPDATE petals SET deleted_at = ? WHERE flower_id = ?').bind(now(), id).run();
  await c.env.DB.prepare('DELETE FROM flowers WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// A shared link to one note serves the same app, but with the note's words
// woven into the social preview, so a text or post shows the words rather
// than a bare link. The app itself reads the path and drifts to the petal.
app.get('/p/:id', async (c) => {
  const asset = await c.env.ASSETS.fetch(new Request(new URL('/', c.req.url).toString(), c.req.raw));
  const row = await c.env.DB.prepare('SELECT text FROM petals WHERE id = ? AND deleted_at IS NULL')
    .bind(c.req.param('id'))
    .first<{ text: string }>();
  if (!row) return asset;

  // The words themselves become the preview, so a text or a tweet shows the
  // note rather than a generic line. iMessage leads with the title (and often
  // drops the description), so the words go in the title; Twitter shows both.
  const flat = row.text.replace(/\s+/g, ' ').trim();
  const title = `“${flat.length > 110 ? flat.slice(0, 109) + '…' : flat}”`;
  const desc = flat.length > 180 ? `${flat.slice(0, 177)}…` : flat;
  const url = new URL(c.req.url).toString();
  const set = (content: string) => ({
    element(el: Element) {
      el.setAttribute('content', content);
    },
  });
  const transformed = new HTMLRewriter()
    .on('title', {
      element(el: Element) {
        el.setInnerContent(title);
      },
    })
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(desc))
    .on('meta[name="twitter:description"]', set(desc))
    .on('meta[property="og:url"]', set(url))
    .transform(asset);
  // Don't let the edge (or a crawler) serve a stale, pre-rewrite copy: each
  // note's preview must be fetched fresh so the words show.
  const out = new Response(transformed.body, transformed);
  out.headers.set('cache-control', 'no-cache');
  return out;
});

// --- static fallback ---------------------------------------------------------
// Static files are served by the assets runtime before the Worker is reached;
// this only catches client navigations, handing back the single page.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
