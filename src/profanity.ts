// A deliberately small filter. The goal is to block the clearly hateful —
// the most obvious slurs — not to police nuance, tone, or feeling.
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
