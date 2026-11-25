import { renderChibi } from '../vendor/ruoruo-chibi-studio/scripts/render.mjs';
import sharp from 'sharp';
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const svg = renderChibi(input);
// Renderer produces local vectors only. Never let SVG load external resources.
if (/<(?:script|image|foreignObject|iframe|style)\b|\bon\w+\s*=|\bhref\s*=|<!ENTITY|<!DOCTYPE|url\(\s*[^#]/i.test(svg)) throw Error('unsafe_svg');
sharp.concurrency(1);
const png = await sharp(Buffer.from(svg), { limitInputPixels: 16_000_000 }).resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: false }).png().toBuffer();
process.stdout.write(png);
