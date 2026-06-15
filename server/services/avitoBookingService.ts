// Avito STR (краткосрочная аренда) Booking sync.
// Источник правды об ОПЛАТЕ брони: messenger API оплату не отдаёт, а в чат
// системного сообщения об оплате Авито не присылает. Поэтому факт оплаты берём
// поллингом realty/booking API (отдельное STR-приложение, client_credentials).
// Признак оплаты — safe_deposit.total_amount (предоплата гостя) → prepaidAmount.
//
// Креды берём из .env (пока тенант фактически один): AVITO_BOOKING_CLIENT_ID/
// SECRET + AVITO_USER_ID. Перенос в TenantAvitoConfig (per-tenant) — отдельный шаг.

import prisma from '../prisma.js'
import { sendMessage, markAsRead, getAllChats, type AvitoChat, type TenantAvitoConfig } from './avitoService.js'
import { getOrCreateDialogue, markMessageProcessed } from './memoryService.js'
import { sendDialogueNotification, sendOpsAlert } from './telegramService.js'
import type { Tenant } from '@prisma/client'

const BOOKING_API = 'https://api.avito.ru'
const TOKEN_URL = 'https://api.avito.ru/token/'

// Сообщение гостю в момент, когда бот узнал об оплате (prepaidAmount 0 → >0).
// Содержит вопрос про время заезда — ответ гостя дальше обрабатывает AI.
// НЕ использовать для ответа на «видите мою оплату?» — там вопрос про время неуместен.
export const PAYMENT_CONFIRM_MSG =
  'Видим, что оплата поступила. Спасибо! Зафиксировали даты за Вами. Скоро направим всю информацию по заселению.\n\nПодскажите, во сколько планируете заселиться?'

// ─── Парсинг брони Avito STR (чистая функция, покрыта тестом) ─────────────────

export interface ParsedAvitoBooking {
  avitoBookingId: string
  guestName: string
  checkIn: string
  checkOut: string
  totalPrice: number
  prepaidAmount: number
  isCancelled: boolean
}

// Avito realty API отдаёт avito_booking_id, contact.name, check_in/out, base_price
// и держит предоплату гостя в safe_deposit.total_amount. Поля бывают под разными
// именами в зависимости от версии — берём первый непустой (как в эталоне SmartApart).
export function parseAvitoBooking(ab: Record<string, unknown>): ParsedAvitoBooking | null {
  const avitoBookingId = String(ab.avito_booking_id ?? ab.id ?? ab.booking_id ?? '')
  if (!avitoBookingId) return null

  const contact = (ab.contact ?? {}) as Record<string, unknown>
  const user = (ab.user ?? {}) as Record<string, unknown>
  const guestName = String(contact.name ?? user.name ?? ab.guest_name ?? 'Авито гость') || 'Авито гость'

  const checkIn = String(ab.check_in ?? ab.date_from ?? ab.begin_date ?? '')
  const checkOut = String(ab.check_out ?? ab.date_to ?? ab.end_date ?? '')

  const totalPrice = Number(ab.base_price ?? ab.price ?? ab.total_price ?? ab.amount ?? 0)
  const safeDeposit = (ab.safe_deposit ?? {}) as Record<string, unknown>
  const prepaidAmount = Number(safeDeposit.total_amount ?? ab.prepaid_amount ?? ab.paid_amount ?? 0)

  const isCancelled = ab.status === 'canceled' || ab.status === 'cancelled'

  return { avitoBookingId, guestName, checkIn, checkOut, totalPrice, prepaidAmount, isCancelled }
}

// Avito отдаёт ISO с временем (T05:00:00Z). Нормализуем к UTC-полночи: у нас
// фиксированное время заезда/выезда, а даты хранятся как UTC midnight.
function toMidnightUTC(dateStr: string): Date {
  const d = new Date(dateStr)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

// ─── STR-токен (client_credentials) с in-memory TTL-кешем ────────────────────

let strTokenCache: { token: string; expiresAt: number } | null = null

export function isBookingSyncConfigured(): boolean {
  return Boolean(
    process.env.AVITO_BOOKING_CLIENT_ID &&
    process.env.AVITO_BOOKING_CLIENT_SECRET &&
    process.env.AVITO_USER_ID
  )
}

async function getStrToken(): Promise<string> {
  const bufferMs = 60 * 1000
  if (strTokenCache && Date.now() < strTokenCache.expiresAt - bufferMs) {
    return strTokenCache.token
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AVITO_BOOKING_CLIENT_ID!,
      client_secret: process.env.AVITO_BOOKING_CLIENT_SECRET!,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`[bookingSync] token error ${res.status}: ${body}`)
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  strTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return data.access_token
}

// ─── Синхронизация броней тенанта ────────────────────────────────────────────

// Бронь, у которой в этом цикле prepaidAmount перешёл 0 → >0 (впервые оплачена).
export interface NewlyPaidBooking {
  bookingId: string
  avitoChatId: string
  guestName: string
}

export interface SyncResult {
  synced: number
  errors: number
  newlyPaid: NewlyPaidBooking[]
}

// Находит свободный (не привязанный к другой брони) чат по item_id и имя гостя.
// booking API не отдаёт chatId и реальное имя — берём их из мессенджера.
function findChatForItem(
  chats: AvitoChat[],
  itemId: string,
  userId: string,
  takenChatIds: Set<string>
): { chatId: string; guestName: string } | null {
  const candidate = chats.find(c => String(c.item_id) === String(itemId) && !takenChatIds.has(c.id))
  if (!candidate) return null
  const guest = (candidate.users || []).find(u => String(u.id) !== String(userId))
  return { chatId: candidate.id, guestName: (guest?.name || '').trim() }
}

// Тянет брони объектов тенанта из STR API и upsert-ит в Booking. Привязывает
// бронь к Авито-чату по item_id (booking API chatId не отдаёт). Возвращает брони,
// впервые получившие предоплату, — для них вызывающий шлёт PAYMENT_CONFIRM_MSG.
export async function syncBookingsForTenant(config: TenantAvitoConfig): Promise<SyncResult> {
  const tenantId = config.tenantId
  const token = await getStrToken()
  const userId = process.env.AVITO_USER_ID!

  const properties = await prisma.property.findMany({
    where: { tenantId, avitoItemId: { not: '' } },
  })

  const now = new Date()
  const to = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
  const dateFrom = now.toISOString().slice(0, 10)
  const dateTo = to.toISOString().slice(0, 10)

  // Чаты тенанта грузим лениво (один раз) — нужны для привязки брони к чату.
  let chats: AvitoChat[] | null = null
  const getChatsOnce = async (): Promise<AvitoChat[]> => {
    if (chats === null) chats = await getAllChats(config).catch(() => [])
    return chats
  }
  // Чаты, уже занятые другими бронями (в т.ч. в БД) — чтобы не линковать на чужой.
  const takenChatIds = new Set<string>(
    (await prisma.booking.findMany({
      where: { tenantId, avitoChatId: { not: '' } },
      select: { avitoChatId: true },
    })).map(b => b.avitoChatId)
  )

  let synced = 0
  let errors = 0
  const newlyPaid: NewlyPaidBooking[] = []

  for (const prop of properties) {
    const itemIds = prop.avitoItemId.split(',').map(s => s.trim()).filter(Boolean)
    for (const itemId of itemIds) {
      try {
        const url = `${BOOKING_API}/realty/v1/accounts/${userId}/items/${itemId}/bookings?date_start=${dateFrom}&date_end=${dateTo}`
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.warn(`[bookingSync][${tenantId}] item=${itemId} HTTP ${res.status}: ${body}`)
          errors++
          continue
        }
        const data = (await res.json()) as { bookings?: unknown[] }
        const rows = (data.bookings ?? []) as Array<Record<string, unknown>>

        for (const row of rows) {
          const parsed = parseAvitoBooking(row)
          if (!parsed || !parsed.checkIn || !parsed.checkOut) continue

          const existing = await prisma.booking.findUnique({
            where: { tenantId_avitoBookingId: { tenantId, avitoBookingId: parsed.avitoBookingId } },
          })

          if (parsed.isCancelled) {
            if (existing) await prisma.booking.delete({ where: { id: existing.id } })
            continue
          }

          const wasPaid = (existing?.prepaidAmount ?? 0) > 0
          const isPaidNow = parsed.prepaidAmount > 0

          const saved = existing
            ? await prisma.booking.update({
                where: { id: existing.id },
                data: {
                  // имя/даты не перетираем «гостём по умолчанию» и пустыми
                  guestName: parsed.guestName !== 'Авито гость' ? parsed.guestName : existing.guestName,
                  totalPrice: parsed.totalPrice,
                  prepaidAmount: parsed.prepaidAmount,
                  accessUnlocked: isPaidNow || existing.accessUnlocked,
                },
              })
            : await prisma.booking.create({
                data: {
                  tenantId,
                  propertyId: prop.id,
                  avitoBookingId: parsed.avitoBookingId,
                  guestName: parsed.guestName,
                  checkIn: toMidnightUTC(parsed.checkIn),
                  checkOut: toMidnightUTC(parsed.checkOut),
                  totalPrice: parsed.totalPrice,
                  prepaidAmount: parsed.prepaidAmount,
                  accessUnlocked: isPaidNow,
                  source: 'Авито',
                },
              })
          synced++

          // Привязка к чату по item_id (если ещё не привязана). Заодно подтягиваем
          // реальное имя гостя из чата — booking API отдаёт «Авито гость».
          let chatId = saved.avitoChatId
          let guestName = saved.guestName
          if (!chatId) {
            const match = findChatForItem(await getChatsOnce(), itemId, userId, takenChatIds)
            if (match) {
              chatId = match.chatId
              takenChatIds.add(chatId)
              const nameFromChat = match.guestName && match.guestName !== 'Авито гость' ? match.guestName : saved.guestName
              await prisma.booking.update({
                where: { id: saved.id },
                data: { avitoChatId: chatId, guestName: nameFromChat },
              })
              guestName = nameFromChat
              console.log(`[bookingSync][${tenantId}] booking=${saved.id} привязана к чату ${chatId}`)
            }
          }

          // Переход 0 → >0 и сообщение ещё не отправляли → кандидат на оплату.
          // Шлём только если бронь привязана к чату (иначе — следующий цикл).
          if (!wasPaid && isPaidNow && !saved.paymentMsgSent && chatId) {
            newlyPaid.push({ bookingId: saved.id, avitoChatId: chatId, guestName })
          }
        }
      } catch (err) {
        console.warn(`[bookingSync][${tenantId}] item=${itemId} error:`, err)
        errors++
      }
    }
  }

  return { synced, errors, newlyPaid }
}

// ─── Отправка сообщения об оплате (часть B) ──────────────────────────────────

// Шлёт PAYMENT_CONFIRM_MSG гостю в Авито-чат, помечает прочитанным, пишет
// bot-сообщение в диалог, ставит paymentMsgSent=true и уведомляет оператора.
// Дедуп — по paymentMsgSent: повторно проверяем перед отправкой (защита от гонок).
export async function sendPaymentConfirmation(
  config: TenantAvitoConfig & { tenant: Tenant },
  booking: NewlyPaidBooking
): Promise<void> {
  const { tenantId, tenant } = config

  // Перепроверяем флаг в БД — другой цикл мог уже отправить.
  const fresh = await prisma.booking.findUnique({ where: { id: booking.bookingId } })
  if (!fresh || fresh.paymentMsgSent) return

  await sendMessage(config, booking.avitoChatId, PAYMENT_CONFIRM_MSG)
  await markAsRead(config, booking.avitoChatId).catch(() => {})

  const dialogue = await getOrCreateDialogue(tenantId, booking.avitoChatId)
  await markMessageProcessed(dialogue.id, `bot-payment-${Date.now()}`, 'BOT', PAYMENT_CONFIRM_MSG)

  await prisma.booking.update({
    where: { id: booking.bookingId },
    data: { paymentMsgSent: true },
  })

  console.log(`[bookingSync][${tenantId}] Оплата подтверждена гостю в чате ${booking.avitoChatId} (booking=${booking.bookingId})`)

  if (tenant.telegramBotToken && tenant.telegramChatId) {
    await sendDialogueNotification(
      tenant.telegramBotToken,
      tenant.telegramChatId,
      booking.avitoChatId,
      booking.guestName,
      '💳 Оплата получена',
      PAYMENT_CONFIRM_MSG
    ).catch(() => {})
  }
  await sendOpsAlert(`[${tenantId}] 💳 Оплата получена, гостю отправлено подтверждение (чат ${booking.avitoChatId})`).catch(() => {})
}
