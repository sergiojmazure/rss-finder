import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { safeFetchText } from './api/_validate.js'

/**
 * Plugin de desarrollo: replica el proxy serverless de `/api/proxy` durante
 * `npm run dev`, usando el MISMO validador anti-SSRF que producción, para que
 * local y Vercel se comporten igual y no haya un proxy abierto en local.
 */
function devProxyPlugin() {
  return {
    name: 'dev-api-proxy',
    configureServer(server) {
      server.middlewares.use('/api/proxy', async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        const target = new URL(req.url, 'http://localhost').searchParams.get('url')
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
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), devProxyPlugin()],
})
