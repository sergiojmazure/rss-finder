import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { safeFetchText } from './api/_validate.js'
import { findFeedsForUrl } from './api/_findFeeds.js'

/**
 * Plugin de desarrollo: replica los endpoints serverless `/api/proxy` y
 * `/api/find` durante `npm run dev`, usando el MISMO código que producción,
 * para que local y Vercel se comporten igual (incluido el anti-SSRF).
 */
function devProxyPlugin() {
  const param = (req) => new URL(req.url, 'http://localhost').searchParams.get('url')

  return {
    name: 'dev-api-proxy',
    configureServer(server) {
      // /api/proxy → devuelve el HTML crudo (respaldo del frontend).
      server.middlewares.use('/api/proxy', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        const target = param(req)
        if (!target) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Falta el parámetro "url".' }))
          return
        }
        try {
          const body = await safeFetchText(target)
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.statusCode = 200
          res.end(body)
        } catch (err) {
          res.statusCode = err && err.statusCode ? err.statusCode : 502
          res.end(JSON.stringify({ error: 'No se pudo descargar el sitio destino.' }))
        }
      })

      // /api/find → devuelve { feeds, source } en JSON (vía principal).
      server.middlewares.use('/api/find', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        const target = param(req)
        if (!target) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Falta el parámetro "url".' }))
          return
        }
        try {
          const result = await findFeedsForUrl(target)
          res.statusCode = 200
          res.end(JSON.stringify(result))
        } catch (err) {
          res.statusCode = err && err.statusCode ? err.statusCode : 502
          res.end(JSON.stringify({ error: 'No se pudo analizar el sitio.' }))
        }
      })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), devProxyPlugin()],
})
