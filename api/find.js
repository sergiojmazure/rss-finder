/**
 * Endpoint principal de búsqueda de feeds: `/api/find?url=<sitio>`.
 *
 * Hace TODO en el servidor (descarga solo el <head>, parsea, heurística) y
 * devuelve un JSON compacto { feeds, source } — el navegador recibe unos
 * cientos de bytes en vez de megas de HTML. Mucho más rápido y cacheable.
 */
import { findFeedsForUrl } from './_findFeeds.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const target =
    (req.query && req.query.url) ||
    new URL(req.url, 'http://localhost').searchParams.get('url');

  if (!target) {
    res.status(400).json({ error: 'Falta el parámetro "url".' });
    return;
  }

  try {
    const result = await findFeedsForUrl(target);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(result);
  } catch (err) {
    const status = err && err.statusCode ? err.statusCode : 502;
    const message =
      status === 400 ? 'URL inválida.'
      : status === 403 ? 'Host no permitido.'
      : 'No se pudo analizar el sitio.';
    if (process.env.VERCEL) console.warn('[find] fallo:', err && err.message);
    res.status(status).json({ error: message });
  }
}
