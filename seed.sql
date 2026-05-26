-- Example flowers: two full, one partial. Quiet, universal notes.
-- Safe to run more than once: existing rows are left untouched.

INSERT OR IGNORE INTO flowers (id, max_petals, created_at, theme) VALUES
  ('a1111111-1111-4111-8111-111111111111', 6, strftime('%s','now'), NULL),
  ('a2222222-2222-4222-8222-222222222222', 6, strftime('%s','now'), NULL),
  ('a3333333-3333-4333-8333-333333333333', 6, strftime('%s','now'), NULL);

-- Flower one (full): six petals.
INSERT OR IGNORE INTO petals
  (id, flower_id, text, color, created_at, spoken_at, medium, direction, relationship, last_renewed_at, reaction_count)
VALUES
  ('b1000001-0001-4001-8001-000000000001', 'a1111111-1111-4111-8111-111111111111',
   'I kept your voicemail just to hear you say my name again.',
   'rose', strftime('%s','now'), strftime('%s','now','-3 years'), 'call', 'received', 'mother', strftime('%s','now'), 4),
  ('b1000002-0002-4002-8002-000000000002', 'a1111111-1111-4111-8111-111111111111',
   'I forgive you, even though you never asked me to.',
   'lavender', strftime('%s','now'), strftime('%s','now','-2 years'), 'in_person', 'gave', 'father', strftime('%s','now'), 2),
  ('b1000003-0003-4003-8003-000000000003', 'a1111111-1111-4111-8111-111111111111',
   'Thank you for staying when leaving would have been easier.',
   'sage', strftime('%s','now'), strftime('%s','now','-1 year'), 'in_person', 'gave', 'partner', strftime('%s','now'), 3),
  ('b1000004-0004-4004-8004-000000000004', 'a1111111-1111-4111-8111-111111111111',
   'I still set out two cups in the morning, out of habit.',
   'gold', strftime('%s','now'), strftime('%s','now','-8 months'), NULL, NULL, NULL, strftime('%s','now'), 1),
  ('b1000005-0005-4005-8005-000000000005', 'a1111111-1111-4111-8111-111111111111',
   'You were right about him. I wish I had listened sooner.',
   'sky', strftime('%s','now'), strftime('%s','now','-4 years'), 'call', 'received', 'sister', strftime('%s','now'), 0),
  ('b1000006-0006-4006-8006-000000000006', 'a1111111-1111-4111-8111-111111111111',
   'I hope you finally found the quiet you were looking for.',
   'rose', strftime('%s','now'), strftime('%s','now','-5 years'), 'letter', 'gave', 'friend', strftime('%s','now'), 2);

-- Flower two (full): six petals.
INSERT OR IGNORE INTO petals
  (id, flower_id, text, color, created_at, spoken_at, medium, direction, relationship, last_renewed_at, reaction_count)
VALUES
  ('b2000001-0001-4001-8001-000000000001', 'a2222222-2222-4222-8222-222222222222',
   'You were my favorite person, and I never said it out loud.',
   'lavender', strftime('%s','now'), strftime('%s','now','-6 years'), 'in_person', 'gave', 'grandmother', strftime('%s','now'), 5),
  ('b2000002-0002-4002-8002-000000000002', 'a2222222-2222-4222-8222-222222222222',
   'The house feels smaller now, without your laugh in it.',
   'sage', strftime('%s','now'), strftime('%s','now','-1 year'), NULL, NULL, NULL, strftime('%s','now'), 1),
  ('b2000003-0003-4003-8003-000000000003', 'a2222222-2222-4222-8222-222222222222',
   'I am proud of you. I do not think I say it enough.',
   'gold', strftime('%s','now'), strftime('%s','now','-2 days'), 'in_person', 'gave', 'son', strftime('%s','now'), 3),
  ('b2000004-0004-4004-8004-000000000004', 'a2222222-2222-4222-8222-222222222222',
   'I read your last message every morning before I get up.',
   'rose', strftime('%s','now'), strftime('%s','now','-2 years'), 'text', 'received', 'partner', strftime('%s','now'), 2),
  ('b2000005-0005-4005-8005-000000000005', 'a2222222-2222-4222-8222-222222222222',
   'I am sorry I was not braver when it would have mattered.',
   'sky', strftime('%s','now'), strftime('%s','now','-3 years'), 'in_person', 'gave', 'daughter', strftime('%s','now'), 1),
  ('b2000006-0006-4006-8006-000000000006', 'a2222222-2222-4222-8222-222222222222',
   'You taught me how to be gentle with myself.',
   'lavender', strftime('%s','now'), strftime('%s','now','-1 year'), 'video', 'received', 'friend', strftime('%s','now'), 4);

-- Flower three (partial): three petals, room for more.
INSERT OR IGNORE INTO petals
  (id, flower_id, text, color, created_at, spoken_at, medium, direction, relationship, last_renewed_at, reaction_count)
VALUES
  ('b3000001-0001-4001-8001-000000000001', 'a3333333-3333-4333-8333-333333333333',
   'I think often about the walk we kept saying we would take.',
   'sage', strftime('%s','now'), strftime('%s','now','-4 years'), 'in_person', 'gave', 'husband', strftime('%s','now'), 2),
  ('b3000002-0002-4002-8002-000000000002', 'a3333333-3333-4333-8333-333333333333',
   'It is alright now. It took a long time, but it is alright.',
   'gold', strftime('%s','now'), strftime('%s','now','-2 years'), NULL, 'gave', 'myself', strftime('%s','now'), 3),
  ('b3000003-0003-4003-8003-000000000003', 'a3333333-3333-4333-8333-333333333333',
   'I would choose it all again, even the hard parts.',
   'rose', strftime('%s','now'), strftime('%s','now','-6 months'), 'in_person', 'gave', 'wife', strftime('%s','now'), 1);
