import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { authMiddleware } from './middleware/auth.js'
import { clientOnly } from './middleware/clientOnly.js'
import { opsOnly } from './middleware/auth.js'
import authRoutes from './routes/auth.js'
import dashboardRoutes from './routes/client/dashboard.js'
import faqRoutes from './routes/client/faq.js'
import propertiesRoutes from './routes/client/properties.js'
import settingsRoutes from './routes/client/settings.js'
import dialoguesRoutes from './routes/client/dialogues.js'
import playgroundRoutes from './routes/client/playground.js'
import calendarRoutes from './routes/client/calendar.js'
import { buildPropertyFeed } from './services/calendarService.js'
import clientsRoutes from './routes/ops/clients.js'
import avitoRoutes from './routes/ops/avito.js'
import contentRoutes from './routes/ops/content.js'
import logsRoutes from './routes/ops/logs.js'
import prisma from './prisma.js'

const AVITO_OAUTH_SCOPE = 'messenger:read messenger:write items:info'

const app = express()
app.use(cors())
app.use(express.json())

app.use(rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}))

app.get('/api/health', async (_, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    const activeBots = await prisma.botSession.count({ where: { isRunning: true } })
    res.json({ status: 'ok', service: 'avitobot-api', db: 'connected', activeBots, uptime: process.uptime() })
  } catch {
    res.status(503).json({ status: 'error', db: 'disconnected' })
  }
})

app.use('/api/auth', authRoutes)

// Public OAuth callback — Авито редиректит сюда без JWT
app.get('/api/client/settings/avito-oauth/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query as Record<string, string>

  const frontendBase = process.env.APP_URL ?? 'https://avitobot.ru'

  if (oauthError) {
    res.redirect(`${frontendBase}/?avito_oauth=error&reason=${encodeURIComponent(oauthError)}`)
    return
  }

  if (!code || !state) {
    res.redirect(`${frontendBase}/?avito_oauth=error&reason=missing_params`)
    return
  }

  let tenantId: string
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString())
    tenantId = parsed.tenantId
  } catch {
    res.redirect(`${frontendBase}/?avito_oauth=error&reason=invalid_state`)
    return
  }

  const avitoConfig = await prisma.tenantAvitoConfig.findUnique({ where: { tenantId } })
  if (!avitoConfig) {
    res.redirect(`${frontendBase}/?avito_oauth=error&reason=no_config`)
    return
  }

  const redirectUri = `${frontendBase}/api/client/settings/avito-oauth/callback`

  try {
    const tokenRes = await fetch('https://api.avito.ru/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: avitoConfig.avitoClientId,
        client_secret: avitoConfig.avitoClientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!tokenRes.ok) {
      const body = await tokenRes.text()
      console.error('[avito-oauth callback] token exchange failed:', body)
      res.redirect(`${frontendBase}/?avito_oauth=error&reason=token_exchange`)
      return
    }

    const data = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in: number }

    await prisma.tenantAvitoConfig.update({
      where: { tenantId },
      data: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? '',
        tokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
      },
    })

    res.redirect(`${frontendBase}/?avito_oauth=success`)
  } catch (err) {
    console.error('[avito-oauth callback] error:', err)
    res.redirect(`${frontendBase}/?avito_oauth=error&reason=server_error`)
  }
})

// Публичный iCal-фид: площадки (Яндекс, Авито, Циан) забирают .ics по cron и
// не умеют слать Authorization — доступ авторизуется секретным токеном в URL.
app.get('/api/calendar/feed/:token.ics', async (req, res) => {
  const token = (req.params as Record<string, string>).token

  try {
    const feed = await prisma.calendarFeed.findUnique({ where: { token } })
    if (!feed) {
      res.status(404).type('text/plain').send('Not found')
      return
    }

    // Площадке не отдаём её же брони: иначе она увидит их как чужую занятость.
    const platform = typeof req.query.for === 'string' ? req.query.for.toUpperCase() : undefined
    const ics = await buildPropertyFeed(feed.propertyId, platform)

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"')
    res.setHeader('Cache-Control', 'no-cache')
    res.send(ics)
  } catch (err) {
    console.error('[calendar feed] error:', err)
    res.status(500).type('text/plain').send('Internal error')
  }
})

app.use('/api/client', authMiddleware, clientOnly, dashboardRoutes)
app.use('/api/client', authMiddleware, clientOnly, faqRoutes)
app.use('/api/client', authMiddleware, clientOnly, propertiesRoutes)
app.use('/api/client', authMiddleware, clientOnly, settingsRoutes)
app.use('/api/client', authMiddleware, clientOnly, dialoguesRoutes)
app.use('/api/client', authMiddleware, clientOnly, playgroundRoutes)
app.use('/api/client', authMiddleware, clientOnly, calendarRoutes)

app.use('/api/ops', authMiddleware, opsOnly, clientsRoutes)
app.use('/api/ops', authMiddleware, opsOnly, avitoRoutes)
app.use('/api/ops', authMiddleware, opsOnly, contentRoutes)
app.use('/api/ops', authMiddleware, opsOnly, logsRoutes)

app.listen(3010, () => console.log('[api] Running on :3010'))
