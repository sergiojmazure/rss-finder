/**
 * Utilidad para buscar feeds RSS dado un URL.
 * Resuelve problemas de CORS utilizando el proxy de AllOrigins.
 */

const CORS_PROXIES = [
  {
    url: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    extract: async (res) => {
      const data = await res.json();
      if (!data.contents) throw new Error('No contents');
      return data.contents;
    }
  },
  {
    url: (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    extract: async (res) => await res.text()
  },
  {
    url: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    extract: async (res) => await res.text()
  },
  {
    url: (url) => `https://thingproxy.freeboard.io/fetch/${encodeURIComponent(url)}`,
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
      const rel = link.getAttribute('rel');
      if (rel && !rel.includes('alternate')) return;

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

    // 2. Si DOMParser falló, intentamos con Regex puro
    if (results.length === 0) {
      const regex = /<link[^>]*href=["']([^"']+)["'][^>]*type=["']application\/(rss|atom)\+xml["'][^>]*>/gi;
      let match;
      while ((match = regex.exec(htmlContent)) !== null) {
        const absoluteUrl = resolveUrl(cleanUrl, match[1]);
        if (!seenUrls.has(absoluteUrl)) {
          seenUrls.add(absoluteUrl);
          results.push({
            url: absoluteUrl,
            type: `application/${match[2]}+xml`,
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
        '/index.xml'
      ];
      
      // Solo probamos los paths contra el dominio raíz para mayor probabilidad de éxito
      const urlObj = new URL(cleanUrl);
      const baseUrl = urlObj.origin;
      
      const checkPromises = commonPaths.map(async (path) => {
        const testUrl = resolveUrl(baseUrl, path);
        try {
          const content = await fetchContentWithProxies(testUrl);
          const head = content.substring(0, 500).toLowerCase();
          
          // Verificar firmas comunes de feeds XML/JSON
          if (head.includes('<rss') || head.includes('<feed') || head.includes('<?xml') || head.includes('"version": "https://jsonfeed.org/version/')) {
            let format = 'application/rss+xml';
            if (head.includes('<feed')) format = 'application/atom+xml';
            if (head.includes('jsonfeed')) format = 'application/json';
            
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

