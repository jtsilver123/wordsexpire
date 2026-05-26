// A deliberately small filter. The goal is to block the clearly hateful,
// the most obvious slurs, not to police nuance, tone, or feeling.
// Intimate words are messy; we let almost everything through.

const BLOCKED = [
  'nigger', 'nigga', 'faggot', 'fag', 'kike', 'spic', 'chink',
  'gook', 'wetback', 'tranny', 'retard', 'coon', 'dyke', 'beaner',
];

// Collapse common letter-for-symbol swaps so "n1gger" is still caught,
// without reaching for anything cleverer than the obvious cases.
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[0]/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/[^a-z\s]/g, ' ');
}

export function isBlocked(text: string): boolean {
  const normalized = normalize(text);
  const words = new Set(normalized.split(/\s+/).filter(Boolean));
  return BLOCKED.some((bad) => words.has(bad));
}

// Link spam is the likeliest abuse for an open note box. Block the obvious
// signals (a scheme, www., or a label.tld) while avoiding TLDs that collide
// with ordinary prose ('call.me', 'rest.in').
const SCHEME_RE = /(https?:\/\/|www\.)/i;
const DOMAIN_RE =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(com|net|org|io|xyz|info|biz|app|dev|site|online|shop|link|click|store|club|live|vip|ru|cn|tk|ga|ml|cf|gq|cc|to)\b/i;

export function hasLink(text: string): boolean {
  return SCHEME_RE.test(text) || DOMAIN_RE.test(text);
}

