/**
 * Validación de URLs para el proxy (compartida entre la función serverless de
 * producción `api/proxy.js` y el middleware de desarrollo en `vite.config.js`).
 *
 * Cierra los vectores SSRF: solo http(s), bloqueo de hosts/IPs internas
 * (loopback, privadas, link-local/metadata, ULA, CGNAT…) tanto si la URL trae
 * una IP literal como resolviendo el DNS del dominio y validando TODAS sus IPs.
 * El archivo empieza por "_" para que Vercel no lo publique como endpoint.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

// Rangos que nunca deben proxearse.
const BLOCKED_RANGES = new Set([
  'unspecified',     // 0.0.0.0, ::
  'broadcast',       // 255.255.255.255
  'loopback',        // 127.0.0.0/8, ::1
  'private',         // 10/8, 172.16/12, 192.168/16
  'linkLocal',       // 169.254/16, fe80::/10  (incluye metadata 169.254.169.254)
  'uniqueLocal',     // fc00::/7
  'carrierGradeNat', // 100.64/10
  'reserved',        // 192.0.0.0/24, 240/4, etc.
]);

const httpError = (statusCode, message) => {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
};

const stripBrackets = (host) =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

// ¿La IP (string) cae en un rango bloqueado? Las no parseables se bloquean.
const ipIsBlocked = (ip) => {
  let addr;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  // Desenvolver IPv4 mapeada en IPv6 (::ffff:127.0.0.1 → 127.0.0.1).
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
    addr = addr.toIPv4Address();
  }
  return BLOCKED_RANGES.has(addr.range());
};

/**
 * Valida una URL destino. Lanza un Error con `.statusCode` si no es admisible.
 * Devuelve el objeto URL ya parseado si es válida.
 */
export async function validateTarget(targetStr) {
  let parsed;
  try {
    parsed = new URL(targetStr);
  } catch {
    throw httpError(400, 'URL inválida.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError(400, 'Solo se admiten URLs http(s).');
  }

  const host = stripBrackets(parsed.hostname).toLowerCase();

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw httpError(403, 'Host no permitido.');
  }

  // IP literal: validar directamente.
  if (net.isIP(host)) {
    if (ipIsBlocked(host)) throw httpError(403, 'Host no permitido.');
    return parsed;
  }

  // Dominio: resolver DNS y validar TODAS las direcciones devueltas.
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw httpError(502, 'No se pudo resolver el host.');
  }
  if (!addrs.length) throw httpError(502, 'El host no tiene direcciones.');
  for (const a of addrs) {
    if (ipIsBlocked(a.address)) throw httpError(403, 'Host no permitido.');
  }

  return parsed;
}

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 BuscaRSS/1.0',
  'Accept':
    'text/html,application/xhtml+xml,application/xml,' +
    'application/rss+xml;q=0.9,application/atom+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

/**
 * Descarga una URL siguiendo redirecciones manualmente y RE-VALIDANDO cada
 * salto (evita SSRF por redirección a un host interno).
 *
 * Opciones:
 *  - maxBytes:   tope de descarga (evita agotar memoria / acelera).
 *  - stopMarker: si aparece esta cadena (p.ej. "</head>"), corta la descarga.
 *  - timeoutMs / maxHops.
 *
 * Devuelve { text, finalUrl, status } — finalUrl es la URL tras redirecciones,
 * necesaria para resolver hrefs relativos correctamente.
 */
export async function safeFetch(initialUrl, { maxBytes = 8 * 1024 * 1024, stopMarker = null, timeoutMs = 9000, maxHops = 4 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let target = await validateTarget(initialUrl);

    let response;
    for (let hop = 0; hop <= maxHops; hop++) {
      response = await fetch(target.href, {
        signal: controller.signal,
        redirect: 'manual',
        headers: DEFAULT_HEADERS,
      });

      // Redirección: re-validar el destino antes de seguir.
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        if (hop === maxHops) throw httpError(502, 'Demasiadas redirecciones.');
        const next = new URL(response.headers.get('location'), target.href).href;
        target = await validateTarget(next);
        continue;
      }
      break;
    }

    const finalUrl = target.href;
    const status = response.status;

    if (!response.body) {
      return { text: await response.text(), finalUrl, status };
    }

    // Streaming con tope de tamaño y corte opcional por marcador (p.ej. </head>).
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const marker = stopMarker ? stopMarker.toLowerCase() : null;
    let text = '';
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      text += decoder.decode(value, { stream: true });
      if (marker && text.toLowerCase().includes(marker)) {
        await reader.cancel();
        break;
      }
      if (received > maxBytes) {
        await reader.cancel();
        break;
      }
    }
    text += decoder.decode();
    return { text, finalUrl, status };
  } finally {
    clearTimeout(timer);
  }
}

/** Igual que safeFetch pero devuelve solo el cuerpo (compat. con api/proxy.js). */
export async function safeFetchText(initialUrl, opts = {}) {
  const { text } = await safeFetch(initialUrl, opts);
  return text;
}
