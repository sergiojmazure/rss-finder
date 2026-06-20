/**
 * Proxy serverless propio (Vercel) para descargar el HTML/feed de un sitio
 * sin depender de proxies CORS públicos de terceros (inestables).
 *
 * El navegador llama a `/api/proxy?url=<destino>` (mismo origen, sin CORS) y
 * esta función hace el fetch del lado del servidor, donde CORS no aplica.
 *
 * La validación anti-SSRF y la descarga segura (redirecciones re-validadas +
 * tope de tamaño) viven en `_validate.js`, compartido con el middleware de dev.
 */
import { safeFetchText } from './_validate.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Vercel rellena req.query, pero parseamos req.url como respaldo.
  const target =
    (req.query && req.query.url) ||
    new URL(req.url, 'http://localhost').searchParams.get('url');

  if (!target) {
    res.status(400).json({ error: 'Falta el parámetro "url".' });
    return;
  }

  try {
    const body = await safeFetchText(target);
    // Cache en el edge de Vercel 5 min para aliviar carga y acelerar repeticiones.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(body);
  } catch (err) {
    // No filtramos el detalle interno al cliente (evita oráculo de escaneo de puertos).
    const status = err && err.statusCode ? err.statusCode : 502;
    const message =
      status === 400 ? 'URL inválida.'
      : status === 403 ? 'Host no permitido.'
      : 'No se pudo descargar el sitio destino.';
    if (process.env.VERCEL) console.warn('[proxy] fallo:', err && err.message);
    res.status(status).json({ error: message });
  }
}
