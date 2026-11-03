import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// 로컬 개발용: Vercel 없이도 /api/* 를 api/ 폴더의 함수로 처리한다
function localApi() {
  return {
    name: 'local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith('/api/')) return next()
        const name = req.url.slice(5).split('?')[0]
        let raw = ''
        for await (const chunk of req) raw += chunk
        try {
          req.body = raw ? JSON.parse(raw) : {}
        } catch {
          req.body = {}
        }
        // Vercel 의 res.status().json() 형태를 흉내 낸다
        res.status = (code) => ((res.statusCode = code), res)
        res.json = (obj) => {
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(obj))
        }
        try {
          const mod = await server.ssrLoadModule(`/api/${name}.js`)
          await mod.default(req, res)
        } catch (e) {
          res.status(500).json({ error: e.message })
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // .env.local 의 서버용 값(VITE_ 접두어 없는 것 포함)을 로컬 함수에서 쓸 수 있게 한다
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''))
  return { plugins: [react(), localApi()] }
})
