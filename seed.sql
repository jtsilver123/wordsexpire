-- Three starter flowers, each holding one quiet petal.
-- Safe to run more than once: existing rows are left untouched.

INSERT OR IGNORE INTO flowers (id, max_petals, created_at, theme) VALUES
  ('11111111-1111-4111-8111-111111111111', 6, strftime('%s','now'), 'what are you carrying?'),
  ('22222222-2222-4222-8222-222222222222', 6, strftime('%s','now'), 'what would you forgive?'),
  ('33333333-3333-4333-8333-333333333333', 7, strftime('%s','now'), 'what are you grateful for?');

INSERT OR IGNORE INTO petals (id, flower_id, text, color, created_at, last_renewed_at, reaction_count) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '11111111-1111-4111-8111-111111111111',
   'I''ve been carrying this for a long time.',
   'rose', strftime('%s','now'), strftime('%s','now'), 0),

  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   '22222222-2222-4222-8222-222222222222',
   'I forgive you, even though you didn''t ask.',
   'lavender', strftime('%s','now'), strftime('%s','now'), 0),

  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
   '33333333-3333-4333-8333-333333333333',
   'The morning light still finds me, and that is enough.',
   'gold', strftime('%s','now'), strftime('%s','now'), 0);
