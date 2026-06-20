/**
 * Motor de búsqueda de feeds del lado servidor (compartido por la función
 * `api/find.js` y el middleware de desarrollo de `vite.config.js`).
 *
 * Estrategia, optimizada para velocidad y fiabilidad:
 *  1. Descarga SOLO el <head> del sitio (corta en </head>, tope 256 KB) — es lo
 *     único necesario para el autodiscovery y evita bajar megas de HTML.
 *  2. Extrae los <link> de feed (orden de atributos indiferente, excluye oEmbed).
 *  3. Si no hay ninguno, prueba rutas comunes (/feed, /rss.xml…) EN PARALELO,
 *     todo dentro de la misma invocación (sin viajes de ida y vuelta del navegador).
 *  Devuelve { feeds: [{url,type,title}], source }.
 */
import { safeFetch } from './_validate.js';

const HEAD_MAX_BYTES = 256 * 1024;

const COMMON_PATHS = [
  '/feed', '/feed/', '/rss', '/rss.xml', '/atom.xml',
  '/feed.xml', '/index.xml', '/feed.json', '/feed/json',
];

const LINK_REGEX = /<link\b[^>]*>/gi;
const TYPE_REGEX = /type=["']([^"']*(?:rss|atom|feed\+json)[^"']*|application\/json|text\/xml)["']/i;
const REL_REGEX = /rel=["']([^"']*)["']/i;
const HREF_REGEX = /href=["']([^"']+)["']/i;
const TITLE_REGEX = /title=["']([^"']*)["']/i;
const NON_FEED_REL = /stylesheet|icon|preload|prefetch|dns-prefetch|manifest|pingback|edituri|apple-touch/;

const normalizeUrl = (raw) => {
  const s = String(raw || '').trim();
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
};

// Extrae feeds de los <link> del HTML (cabecera). baseUrl resuelve hrefs relativos.
export function extractFeedLinks(html, baseUrl) {
  const feeds = [];
  const seen = new Set();
  let m;
  while ((m = LINK_REGEX.exec(html)) !== null) {
    const tag = m[0];
    const typeMatch = TYPE_REGEX.exec(tag);
    if (!typeMatch) continue;
    if (typeMatch[1].toLowerCase().includes('oembed')) continue;

    const rel = (REL_REGEX.exec(tag)?.[1] || '').toLowerCase();
    if (NON_FEED_REL.test(rel)) continue;

    const hrefMatch = HREF_REGEX.exec(tag);
    if (!hrefMatch) continue;

    let abs;
    try { abs = new URL(hrefMatch[1], baseUrl).href; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);

    feeds.push({
      url: abs,
      type: typeMatch[1],
      title: TITLE_REGEX.exec(tag)?.[1] || 'Feed',
    });
  }
  return feeds;
}

// Detecta el tipo de feed a partir del inicio del contenido. null si no lo es.
function feedTypeFromContent(content) {
  const head = content.slice(0, 600).toLowerCase();
  if (head.includes('jsonfeed.org/version')) return 'application/feed+json';
  if (head.includes('<feed')) return 'application/atom+xml';
  if (head.includes('<rss') || head.includes('<?xml') || head.includes('<rdf')) return 'application/rss+xml';
  return null;
}

// Prueba rutas comunes en paralelo contra el origen; devuelve las que son feeds.
async function probeCommonPaths(origin) {
  const checks = await Promise.all(COMMON_PATHS.map(async (path) => {
    const testUrl = new URL(path, origin).href;
    try {
      const { text } = await safeFetch(testUrl, { maxBytes: 4096, timeoutMs: 7000 });
      const type = feedTypeFromContent(text);
      if (type) return { url: testUrl, type, title: `Feed (${path})` };
    } catch { /* ignorar ruta que no existe */ }
    return null;
  }));

  const seen = new Set();
  return checks.filter((r) => r && !seen.has(r.url) && seen.add(r.url));
}

/**
 * Busca los feeds de una URL. Punto de entrada del endpoint /api/find.
 * Devuelve { feeds, source } donde source ∈ {'autodiscovery','heuristic'}.
 */
export async function findFeedsForUrl(rawUrl) {
  const cleanUrl = normalizeUrl(rawUrl);

  // 1) Descargar solo el <head> y extraer los <link> de feed.
  const { text, finalUrl } = await safeFetch(cleanUrl, {
    stopMarker: '</head>',
    maxBytes: HEAD_MAX_BYTES,
  });

  const feeds = extractFeedLinks(text, finalUrl);
  if (feeds.length > 0) {
    return { feeds, source: 'autodiscovery' };
  }

  // 2) Sin autodiscovery: probar rutas comunes contra el origen final.
  const origin = new URL(finalUrl).origin;
  const probed = await probeCommonPaths(origin);
  return { feeds: probed, source: 'heuristic' };
}
