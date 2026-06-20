/**
 * Utilidad para buscar feeds RSS dado un URL.
 *
 * Para esquivar CORS descargamos el HTML del sitio destino a través de un proxy.
 * Vía principal: nuestro propio proxy serverless (`/api/proxy`, mismo origen, sin
 * dependencias de terceros). Como red de seguridad mantenemos algunos proxies
 * públicos que SÍ funcionan a día de hoy. (Se eliminaron corsproxy.io —ahora de
 * pago, 403— y thingproxy.freeboard.io —difunto—, y allorigins pasó de /get a /raw).
 */

const CORS_PROXIES = [
  // 1) Proxy propio (Vercel). Mismo origen → sin CORS, sin terceros. Vía principal.
  {
    url: (url) => `/api/proxy?url=${encodeURIComponent(url)}`,
    extract: async (res) => await res.text()
  },
  // 2) AllOrigins /raw (devuelve el cuerpo crudo; /get estaba dando 500).
  {
    url: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    extract: async (res) => await res.text()
  },
  // 3) Codetabs como último recurso (a veces funciona desde el navegador).
  {
    url: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    extract: async (res) => await res.text()
  }
];

const resolveUrl = (baseUrl, relativeUrl) => {
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch (e) {
    return relativeUrl;
  }
};

const fetchContentWithProxies = async (targetUrl) => {
  let lastError;
  for (const proxy of CORS_PROXIES) {
    try {
      const proxyUrl = proxy.url(targetUrl);
      const response = await fetch(proxyUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = await proxy.extract(response);
      
      if (content && typeof content === 'string' && content.length > 20) {
        const lower = content.toLowerCase();
        // Detección agresiva de páginas de bloqueo (Cloudflare, Sucuri, etc.)
        if (
          lower.includes('<title>just a moment...</title>') || 
          lower.includes('cf-browser-verification') ||
          lower.includes('attention required! | cloudflare') ||
          lower.includes('enable javascript and cookies to continue') ||
          lower.includes('please wait while your request is being verified') ||
          lower.includes('security by cloudflare') ||
          lower.includes('sucuri web site firewall') ||
          lower.includes('<title>access denied')
        ) {
          throw new Error('WAF block detected (Cloudflare/Sucuri/etc)');
        }
        return content;
      }
    } catch (err) {
      console.warn(`Proxy ${proxy.url(targetUrl)} failed:`, err.message || err);
      lastError = err;
    }
  }
  throw lastError || new Error('All proxies failed or were blocked.');
};

export const findRssFeeds = async (targetUrl) => {
  let cleanUrl = targetUrl.trim();
  if (!cleanUrl.startsWith('http')) {
    cleanUrl = 'https://' + cleanUrl;
  }
  
  try {
    const htmlContent = await fetchContentWithProxies(cleanUrl);
    const results = [];
    const seenUrls = new Set();
    
    // 1. Intentamos Parsear con DOMParser
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');
    
    // Selectores más permisivos (por substring)
    const feedSelectors = [
      'link[type*="rss"]',
      'link[type*="atom"]',
      'link[type*="json"]',
      'link[type="text/xml"]'
    ];
    
    const linkTags = doc.querySelectorAll(feedSelectors.join(', '));

    linkTags.forEach(link => {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      // El selector ya filtra por tipo de feed: solo descartamos rels que
      // claramente NO son un feed (acepta ausencia de rel, "alternate" o "feed").
      if (/stylesheet|icon|preload|prefetch|dns-prefetch|manifest|pingback|edituri|apple-touch/.test(rel)) return;

      // Descartar oEmbed (application/json+oembed / xml+oembed): no es un feed.
      const linkType = (link.getAttribute('type') || '').toLowerCase();
      if (linkType.includes('oembed')) return;

      const rawHref = link.getAttribute('href');
      if (!rawHref) return;
      
      const absoluteUrl = resolveUrl(cleanUrl, rawHref);
      
      if (seenUrls.has(absoluteUrl)) return;
      seenUrls.add(absoluteUrl);
      
      results.push({
        url: absoluteUrl,
        type: link.getAttribute('type') || 'application/rss+xml',
        title: link.getAttribute('title') || 'Feed'
      });
    });

    // 2. Si DOMParser falló, intentamos con Regex puro.
    //    Independiente del orden de atributos: primero aislamos cada <link>,
    //    luego extraemos href y type por separado (WordPress y la mayoría de
    //    CMS emiten `type` antes que `href`).
    if (results.length === 0) {
      const linkRegex = /<link\b[^>]*>/gi;
      const feedTypeRegex = /type=["']([^"']*(?:rss|atom|feed\+json)[^"']*|application\/json|text\/xml)["']/i;
      const hrefRegex = /href=["']([^"']+)["']/i;
      let match;
      while ((match = linkRegex.exec(htmlContent)) !== null) {
        const tag = match[0];
        const typeMatch = feedTypeRegex.exec(tag);
        if (!typeMatch) continue;
        if (typeMatch[1].toLowerCase().includes('oembed')) continue;
        const hrefMatch = hrefRegex.exec(tag);
        if (!hrefMatch) continue;
        const absoluteUrl = resolveUrl(cleanUrl, hrefMatch[1]);
        if (!seenUrls.has(absoluteUrl)) {
          seenUrls.add(absoluteUrl);
          results.push({
            url: absoluteUrl,
            type: typeMatch[1],
            title: 'Feed (Detectado via Texto)'
          });
        }
      }
    }

    // 3. Fallback Heurístico Activo (Probamos endpoints comunes en paralelo)
    if (results.length === 0) {
      console.log("No se encontraron links en el DOM. Iniciando heurística activa...");
      const commonPaths = [
        '/feed',
        '/feed/',
        '/rss',
        '/rss.xml',
        '/atom.xml',
        '/feed.xml',
        '/index.xml',
        '/feed.json',
        '/feed/json'
      ];
      
      // Solo probamos los paths contra el dominio raíz para mayor probabilidad de éxito
      const urlObj = new URL(cleanUrl);
      const baseUrl = urlObj.origin;
      
      const checkPromises = commonPaths.map(async (path) => {
        const testUrl = resolveUrl(baseUrl, path);
        try {
          const content = await fetchContentWithProxies(testUrl);
          const head = content.substring(0, 500).toLowerCase();
          
          // Verificar firmas comunes de feeds XML/JSON.
          // (jsonfeed.org/version sin exigir espacios: el JSON real va minificado)
          if (head.includes('<rss') || head.includes('<feed') || head.includes('<?xml') || head.includes('jsonfeed.org/version')) {
            let format = 'application/rss+xml';
            if (head.includes('<feed')) format = 'application/atom+xml';
            if (head.includes('jsonfeed')) format = 'application/feed+json';
            
            return {
              url: testUrl,
              type: format,
              title: `Feed Principal (${path})`
            };
          }
        } catch (e) {
          return null;
        }
        return null;
      });
      
      const checks = await Promise.all(checkPromises);
      checks.forEach(res => {
        if (res && !seenUrls.has(res.url)) {
          seenUrls.add(res.url);
          results.push(res);
        }
      });
    }

    return results;

  } catch (error) {
    console.error('Error finding RSS feeds:', error);
    throw error;
  }
};

