# WordsExpire

A quiet garden where people leave brief, often intimate notes — petals — on
flowers. Each flower holds a few petals. A petal fades with time unless others
gently touch it, which renews its life. No accounts. No likes, counters, or
streaks. Just words, and the slow weather of attention.

Each note can also carry the date its words were first said — today by default,
or reaching back in time.

## How it works

- A flower has a handful of petal slots. Empty slots are faint outlines.
- Leaving a petal places a small note (up to 280 characters).
- A petal's color softens and recedes as it loses aliveness:
  `aliveness = max(0, 1 - (now - last_renewed_at) / 7 days)`.
- Touching a petal ("keep alive") resets its clock, once per person per day.
- A petal that reaches the end of its life lingers as a faint ghost for two
  days, then is quietly let go.

## Stack

One Cloudflare Worker (TypeScript, [Hono](https://hono.dev)) serves both the
static garden in `/public` and the API. Storage is Cloudflare D1 (SQLite).
No client framework, no build step.

```
public/        the garden — index.html, styles.css, app.js
src/index.ts   the Worker: API, decay, rate limiting, admin
src/profanity.ts  a small, deliberately narrow slur filter
schema.sql     tables for flowers, petals, reactions
seed.sql       three starter flowers, each with one quiet petal
```

## Running locally

```sh
npm install

# create the local database and seed it
npx wrangler d1 execute wordsexpire --local --file=schema.sql
npx wrangler d1 execute wordsexpire --local --file=seed.sql

# local secrets — copy and edit
cp .dev.vars.example .dev.vars

npm run dev          # http://localhost:8787
```

Local development needs no Cloudflare account; the database lives on disk under
`.wrangler/`.

## API

| Method | Path                          | Purpose                                  |
| ------ | ----------------------------- | ---------------------------------------- |
| GET    | `/api/flowers`                | active flowers with petals + aliveness   |
| GET    | `/api/flowers/:id`            | one flower                               |
| POST   | `/api/flowers`                | plant a new flower                       |
| POST   | `/api/flowers/:id/petals`     | leave a petal `{ text, spokenAt? }`      |
| POST   | `/api/petals/:id/react`       | keep a petal alive                       |
| GET    | `/admin/flowers`              | list all (bearer `ADMIN_TOKEN`)          |
| DELETE | `/admin/petals/:id`           | remove a petal                           |
| DELETE | `/admin/flowers/:id`          | remove a flower and its petals           |

Abuse is kept at the door, gently: per-IP rate limits (5 petals/hour, 30
keep-alives/hour), a hidden honeypot field, a 280-character limit, a small
filter for the clearly hateful, and one keep-alive per person per petal per
day. IPs are never stored — only a salted SHA-256 hash.

## Deploying

```sh
# 1. create the database, then paste its id into wrangler.jsonc
npx wrangler d1 create wordsexpire

# 2. apply the schema and seed to the remote database
npx wrangler d1 execute wordsexpire --remote --file=schema.sql
npx wrangler d1 execute wordsexpire --remote --file=seed.sql

# 3. set the secrets (generate strong random values)
npx wrangler secret put IP_HASH_SALT
npx wrangler secret put ADMIN_TOKEN

# 4. deploy
npx wrangler deploy
```

The Worker is then live at `https://wordsexpire.<your-subdomain>.workers.dev`.

### Attaching a custom domain

Once `wordsexpire.com`'s DNS is managed by Cloudflare, add a route in
`wrangler.jsonc` (or via the dashboard under Workers → your Worker → Settings →
Domains & Routes) and redeploy:

```jsonc
"routes": [
  { "pattern": "wordsexpire.com", "custom_domain": true },
  { "pattern": "www.wordsexpire.com", "custom_domain": true }
]
```

Cloudflare provisions the certificate automatically.

---

When in doubt, this project chooses the quieter thing. The design should
disappear, so the words can be heard.
