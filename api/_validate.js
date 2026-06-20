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

/**
 * Descarga una URL siguiendo redirecciones manualmente y RE-VALIDANDO cada
 * salto (evita SSRF por redirección a un host interno). Aplica un tope de
 * tamaño para evitar agotar memoria. Devuelve el cuerpo como string.
 */
export async function safeFetchText(initialUrl, { maxBytes = 8 * 1024 * 1024, timeoutMs = 9000, maxHops = 4 } = {}) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36 BuscaRSS/1.0',
    'Accept':
      'text/html,application/xhtml+xml,application/xml,' +
      'application/rss+xml;q=0.9,application/atom+xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let target = await validateTarget(initialUrl);

    let response;
    for (let hop = 0; hop <= maxHops; hop++) {
      response = await fetch(target.href, {
        signal: controller.signal,
        redirect: 'manual',
        headers,
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

    // Leer con tope de tamaño (streaming) para no agotar memoria.
    if (!response.body) return await response.text();
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf-8');
  } finally {
    clearTimeout(timer);
  }
}
