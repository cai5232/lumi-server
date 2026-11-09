import { markRecall } from '../media.js';

function contentOf(hit, resolved) {
  if (typeof resolved === 'string') return resolved;
  if (typeof resolved?.content === 'string') return resolved.content;
  if (typeof resolved?.text === 'string') return resolved.text;
  if (typeof hit?.excerpt === 'string') return hit.excerpt;
  if (typeof hit?.summary === 'string') return hit.summary;
  return '';
}

/**
 * Convert Tidal Memory search results into one-request Dayflow recall messages.
 * Callbacks keep this package independent from a particular Tidal deployment.
 */
export async function recallFromTidal({ search, resolve, query, limit = 3 }) {
  if (typeof search !== 'function') throw new TypeError('search must be a function');
  const hits = await search(query, { limit });
  if (!Array.isArray(hits)) throw new TypeError('search must return an array');

  const selected = hits.slice(0, limit);
  return Promise.all(selected.map(async hit => {
    const resolved = typeof resolve === 'function' ? await resolve(hit) : undefined;
    const content = contentOf(hit, resolved);
    if (!content) return null;
    return markRecall(content, hit?.anchor || hit?.source || hit?.id);
  })).then(messages => messages.filter(Boolean));
}
