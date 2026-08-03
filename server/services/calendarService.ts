import crypto from 'node:crypto'
import prisma from '../prisma.js'
import { parseIcal, buildIcal, type IcalExportEvent } from './icalService.js'

// Синхронизация занятости между площадками через iCal.
//
// Модель: занятость объекта = наши брони из Avito API (Booking) + блокировки,
// втянутые из чужих iCal-фидов (CalendarBlock). Наш экспортный фид отдаёт
// объединение обоих источников, поэтому бронь с Авито закрывает даты в Яндексе,
// а бронь с Яндекса — на Авито.
//
// Отмена работает без спецлогики: блокировки фида пересоздаются при каждом
// успешном pull, а снятая на той стороне бронь просто исчезает из .ics.

const FETCH_TIMEOUT_MS = 20_000
const MAX_FEED_BYTES = 5 * 1024 * 1024

/** Брони с этими статусами не занимают даты. */
const CANCELLED_STATUSES = ['ОТМЕНЕНО', 'ОТМЕНЕНА', 'CANCELLED', 'CANCELED']

export function isBookingActive(status: string): boolean {
  return !CANCELLED_STATUSES.includes(status.trim().toUpperCase())
}

export function generateFeedToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/**
 * Загружает .ics по URL.
 * Отдельно жёсткие таймаут и лимит размера: URL задаёт клиент, а зависший или
 * гигантский ответ чужой площадки не должен подвешивать цикл синхронизации.
 */
async function fetchIcalText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'AvitoBot-Calendar/1.0', Accept: 'text/calendar, text/plain, */*' },
    })

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const text = await res.text()
    if (text.length > MAX_FEED_BYTES) throw new Error('Фид слишком большой')
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Ответ не похож на iCal-календарь')

    return text
  } finally {
    clearTimeout(timer)
  }
}

/** Только http(s) и только публичные адреса — URL приходит от клиента (SSRF). */
export function validateFeedUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return 'Некорректная ссылка'
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Ссылка должна начинаться с http:// или https://'
  }

  const host = parsed.hostname.toLowerCase()
  const isPrivate =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host)

  if (isPrivate) return 'Ссылка на внутренний адрес недопустима'

  return null
}

export interface SyncOneResult {
  syncId: string
  platform: string
  ok: boolean
  eventCount: number
  error?: string
}

/**
 * Тянет один внешний фид и полностью заменяет его блокировки.
 * Замена идёт в транзакции: иначе при падении между delete и create объект
 * на момент сбоя выглядел бы полностью свободным — прямой путь к овербукингу.
 */
export async function syncOneFeed(syncId: string): Promise<SyncOneResult> {
  const sync = await prisma.calendarSync.findUnique({ where: { id: syncId } })
  if (!sync) return { syncId, platform: '', ok: false, eventCount: 0, error: 'Канал не найден' }

  const base = { syncId, platform: sync.platform }

  if (!sync.isActive || !sync.importUrl) {
    return { ...base, ok: true, eventCount: 0 }
  }

  try {
    const text = await fetchIcalText(sync.importUrl)
    const events = parseIcal(text)

    await prisma.$transaction(async tx => {
      await tx.calendarBlock.deleteMany({ where: { syncId } })
      if (events.length) {
        await tx.calendarBlock.createMany({
          data: events.map(ev => ({
            tenantId: sync.tenantId,
            syncId,
            uid: ev.uid,
            summary: ev.summary,
            start: ev.start,
            end: ev.end,
          })),
        })
      }
      await tx.calendarSync.update({
        where: { id: syncId },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: 'ОК',
          lastSyncError: '',
          lastEventCount: events.length,
        },
      })
    })

    return { ...base, ok: true, eventCount: events.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // Блокировки прошлого успешного pull намеренно НЕ трогаем: протухшие занятые
    // даты безопаснее, чем ложно свободные при недоступной площадке.
    await prisma.calendarSync.update({
      where: { id: syncId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: 'ОШИБКА',
        lastSyncError: message.slice(0, 300),
      },
    }).catch(() => {})

    return { ...base, ok: false, eventCount: 0, error: message }
  }
}

/** Синхронизирует все активные каналы тенанта. */
export async function syncTenantCalendars(tenantId: string): Promise<SyncOneResult[]> {
  const syncs = await prisma.calendarSync.findMany({
    where: { tenantId, isActive: true, importUrl: { not: '' } },
    select: { id: true },
  })

  const results: SyncOneResult[] = []
  for (const { id } of syncs) {
    results.push(await syncOneFeed(id))
  }
  return results
}

/**
 * Собирает наш экспортный .ics для объекта: брони из Avito + блокировки прочих
 * площадок, КРОМЕ той, кому фид предназначен (excludePlatform) — иначе площадка
 * получит обратно собственные брони и это выглядит как чужая занятость.
 */
export async function buildPropertyFeed(propertyId: string, excludePlatform?: string): Promise<string> {
  const property = await prisma.property.findUnique({ where: { id: propertyId } })
  if (!property) throw new Error('Объект не найден')

  const [bookings, blocks] = await Promise.all([
    prisma.booking.findMany({ where: { propertyId }, orderBy: { checkIn: 'asc' } }),
    prisma.calendarBlock.findMany({
      where: {
        sync: {
          propertyId,
          isActive: true,
          ...(excludePlatform ? { platform: { not: excludePlatform } } : {}),
        },
      },
      include: { sync: true },
      orderBy: { start: 'asc' },
    }),
  ])

  const events: IcalExportEvent[] = []

  for (const b of bookings) {
    if (!isBookingActive(b.status)) continue
    events.push({
      uid: `booking-${b.id}@avitobot`,
      // Имя гостя намеренно не отдаём: фид публичный по токену, а iCal между
      // площадками персональные данные не передаёт.
      summary: `Занято (${b.source || 'Авито'})`,
      start: b.checkIn,
      end: b.checkOut,
    })
  }

  for (const blk of blocks) {
    events.push({
      uid: `block-${blk.id}@avitobot`,
      summary: `Занято (${blk.sync.platform})`,
      start: blk.start,
      end: blk.end,
    })
  }

  return buildIcal(property.name || 'Календарь', events)
}
