import { Router } from 'express'
import prisma from '../../prisma.js'
import {
  syncOneFeed,
  syncTenantCalendars,
  validateFeedUrl,
  generateFeedToken,
  isBookingActive,
} from '../../services/calendarService.js'

const router = Router()

const PLATFORMS = ['ЯНДЕКС', 'АВИТО', 'ЦИАН', 'ДРУГОЕ']

/** Горизонт календаря по умолчанию — от начала текущего месяца на 3 месяца вперёд. */
function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const now = new Date()
  const defFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const defTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 0))

  const parsedFrom = from ? new Date(from) : defFrom
  const parsedTo = to ? new Date(to) : defTo

  return {
    from: isNaN(parsedFrom.getTime()) ? defFrom : parsedFrom,
    to: isNaN(parsedTo.getTime()) ? defTo : parsedTo,
  }
}

// Сетка занятости: объекты × интервалы. Фронт раскладывает по дням сам.
router.get('/calendar', async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const { from, to } = parseRange(req.query.from as string, req.query.to as string)

  try {
    const properties = await prisma.property.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      include: {
        calendarSyncs: true,
        calendarFeed: true,
      },
    })

    const propertyIds = properties.map(p => p.id)

    // Пересечение с окном: бронь видна, если начинается до конца окна и
    // заканчивается после его начала.
    const [bookings, blocks] = await Promise.all([
      prisma.booking.findMany({
        where: { tenantId, propertyId: { in: propertyIds }, checkIn: { lte: to }, checkOut: { gte: from } },
        orderBy: { checkIn: 'asc' },
      }),
      prisma.calendarBlock.findMany({
        where: {
          tenantId,
          start: { lte: to },
          end: { gte: from },
          sync: { isActive: true, propertyId: { in: propertyIds } },
        },
        include: { sync: true },
        orderBy: { start: 'asc' },
      }),
    ])

    const items = properties.map(p => {
      const own = bookings
        .filter(b => b.propertyId === p.id && isBookingActive(b.status))
        .map(b => ({
          id: b.id,
          kind: 'booking' as const,
          platform: b.source || 'Авито',
          guestName: b.guestName,
          start: b.checkIn.toISOString(),
          end: b.checkOut.toISOString(),
          totalPrice: b.totalPrice,
          isPaid: b.prepaidAmount > 0,
        }))

      const external = blocks
        .filter(b => b.sync.propertyId === p.id)
        .map(b => ({
          id: b.id,
          kind: 'block' as const,
          platform: b.sync.platform,
          guestName: '',
          start: b.start.toISOString(),
          end: b.end.toISOString(),
          totalPrice: 0,
          isPaid: false,
        }))

      return {
        propertyId: p.id,
        name: p.name,
        address: p.address,
        avitoItemId: p.avitoItemId,
        hasFeed: Boolean(p.calendarFeed),
        syncs: p.calendarSyncs.map(s => ({
          id: s.id,
          platform: s.platform,
          importUrl: s.importUrl,
          isActive: s.isActive,
          lastSyncAt: s.lastSyncAt?.toISOString() ?? null,
          lastSyncStatus: s.lastSyncStatus,
          lastSyncError: s.lastSyncError,
          lastEventCount: s.lastEventCount,
        })),
        intervals: [...own, ...external].sort((a, b) => a.start.localeCompare(b.start)),
      }
    })

    res.json({ from: from.toISOString(), to: to.toISOString(), properties: items })
  } catch (err) {
    console.error('[calendar GET] error:', err)
    res.status(500).json({ error: 'Не удалось загрузить календарь' })
  }
})

// Подключить/обновить внешний iCal-канал объекта.
router.post('/calendar/syncs', async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const { propertyId, platform, importUrl } = req.body as {
    propertyId?: string
    platform?: string
    importUrl?: string
  }

  if (!propertyId || !platform) {
    res.status(400).json({ error: 'propertyId и platform обязательны' })
    return
  }

  const normalizedPlatform = platform.trim().toUpperCase()
  if (!PLATFORMS.includes(normalizedPlatform)) {
    res.status(400).json({ error: `platform должен быть одним из: ${PLATFORMS.join(', ')}` })
    return
  }

  const url = (importUrl ?? '').trim()
  if (url) {
    const urlError = validateFeedUrl(url)
    if (urlError) {
      res.status(400).json({ error: urlError })
      return
    }
  }

  const property = await prisma.property.findFirst({ where: { id: propertyId, tenantId } })
  if (!property) {
    res.status(404).json({ error: 'Объект не найден' })
    return
  }

  try {
    const sync = await prisma.calendarSync.upsert({
      where: { propertyId_platform: { propertyId, platform: normalizedPlatform } },
      create: { tenantId, propertyId, platform: normalizedPlatform, importUrl: url },
      update: { importUrl: url, isActive: true },
    })

    // Сразу тянем фид: клиент должен увидеть результат подключения немедленно,
    // а не через полчаса до следующего цикла.
    const result = url ? await syncOneFeed(sync.id) : null

    res.status(201).json({ sync: { id: sync.id, platform: sync.platform }, result })
  } catch (err) {
    console.error('[calendar/syncs POST] error:', err)
    res.status(500).json({ error: 'Не удалось подключить календарь' })
  }
})

router.delete('/calendar/syncs/:id', async (req, res) => {
  const tenantId = req.auth!.tenantId!

  const sync = await prisma.calendarSync.findFirst({ where: { id: req.params.id, tenantId } })
  if (!sync) {
    res.status(404).json({ error: 'Канал не найден' })
    return
  }

  try {
    // Блокировки уходят каскадом — даты, закрытые этим каналом, открываются.
    await prisma.calendarSync.delete({ where: { id: sync.id } })
    res.json({ ok: true })
  } catch (err) {
    console.error('[calendar/syncs DELETE] error:', err)
    res.status(500).json({ error: 'Не удалось отключить календарь' })
  }
})

// Принудительная синхронизация — кнопка «Обновить сейчас».
router.post('/calendar/sync', async (req, res) => {
  const tenantId = req.auth!.tenantId!

  try {
    const results = await syncTenantCalendars(tenantId)
    res.json({
      ok: true,
      synced: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    })
  } catch (err) {
    console.error('[calendar/sync POST] error:', err)
    res.status(500).json({ error: 'Не удалось синхронизировать' })
  }
})

// Ссылка на наш экспортный .ics — её клиент вставляет в экстранет площадки.
router.post('/calendar/feed', async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const { propertyId, rotate } = req.body as { propertyId?: string; rotate?: boolean }

  if (!propertyId) {
    res.status(400).json({ error: 'propertyId обязателен' })
    return
  }

  const property = await prisma.property.findFirst({ where: { id: propertyId, tenantId } })
  if (!property) {
    res.status(404).json({ error: 'Объект не найден' })
    return
  }

  try {
    const token = generateFeedToken()
    const feed = await prisma.calendarFeed.upsert({
      where: { propertyId },
      create: { tenantId, propertyId, token },
      update: rotate ? { token } : {},
    })

    const base = process.env.APP_URL ?? ''
    res.json({ token: feed.token, url: `${base}/api/calendar/feed/${feed.token}.ics` })
  } catch (err) {
    console.error('[calendar/feed POST] error:', err)
    res.status(500).json({ error: 'Не удалось создать ссылку' })
  }
})

export default router
