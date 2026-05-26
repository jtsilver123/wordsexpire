// One-off: render the social preview image (public/og.png) from an SVG.
// Run with: npm i sharp && node scripts/og.mjs
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const W = 1200;
const H = 630;

// A bloom centered at (cx, cy), petals fanning out, gold heart, soft halo.
function bloom(cx, cy, scale) {
  const petals = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (360 / n) * i;
    petals.push(
      `<ellipse rx="46" ry="94" cx="0" cy="-104" fill="url(#petal)" stroke="rgba(120,80,66,0.18)" stroke-width="1.5" transform="rotate(${a})" />`,
    );
  }
  let stamens = '';
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI * 2 * i) / 16;
    const rr = 16 + (i % 3) * 6;
    stamens += `<circle cx="${Math.cos(a) * rr}" cy="${Math.sin(a) * rr}" r="${i % 3 === 0 ? 3 : 2}" fill="${
      i % 3 === 0 ? 'rgba(150,108,52,0.6)' : 'rgba(252,245,224,0.9)'
    }" />`;
  }
  return `<g transform="translate(${cx} ${cy}) scale(${scale})">
    <circle r="180" fill="url(#halo)" />
    <g>${petals.join('')}</g>
    <circle r="34" fill="url(#heart)" stroke="rgba(120,90,50,0.18)" />
    ${stamens}
  </g>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f4eddf" />
      <stop offset="0.5" stop-color="#e2e7da" />
      <stop offset="1" stop-color="#c7d6cd" />
    </linearGradient>
    <radialGradient id="glow" cx="0.7" cy="0.2" r="0.7">
      <stop offset="0" stop-color="rgba(255,255,255,0.5)" />
      <stop offset="1" stop-color="rgba(255,255,255,0)" />
    </radialGradient>
    <linearGradient id="petal" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e7c2bc" />
      <stop offset="0.55" stop-color="#d7a39c" />
      <stop offset="1" stop-color="#b07d72" />
    </linearGradient>
    <radialGradient id="heart">
      <stop offset="0" stop-color="#f6ead0" />
      <stop offset="0.55" stop-color="#e3cf9c" />
      <stop offset="1" stop-color="#c9a86a" />
    </radialGradient>
    <radialGradient id="halo">
      <stop offset="0" stop-color="rgba(247,236,206,0.6)" />
      <stop offset="1" stop-color="rgba(247,236,206,0)" />
    </radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)" />
  <rect width="${W}" height="${H}" fill="url(#glow)" />

  ${bloom(905, 315, 1.18)}

  <text x="110" y="300" font-family="Georgia, 'Times New Roman', serif" font-size="96" fill="#3a332c">WordsExpire</text>
  <text x="114" y="368" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="40" fill="#8c8278">leave a small note.</text>
  <text x="114" y="424" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="40" fill="#8c8278">it fades unless others keep it alive.</text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(new URL('../public/og.png', import.meta.url), png);
console.log('wrote public/og.png', png.length, 'bytes');
