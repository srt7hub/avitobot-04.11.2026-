import prisma from '../prisma.js'
import { sendMessage, markAsRead, type TenantAvitoConfig } from './avitoService.js'
import { getOrCreateDialogue, markMessageProcessed } from './memoryService.js'
import { sendCheckinApprovalRequest } from './telegramService.js'
import type { Tenant, TenantAvitoConfig as PrismaTenantAvitoConfig } from '@prisma/client'

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000
const THIRTY_MINUTES_MS = 30 * 60 * 1000

type ConfigWithTenant = PrismaTenantAvitoConfig & { tenant: Tenant }

function checkinTimeParts(): { hour: number; minute: number } {
  const value = process.env.CHECKIN_DEFAULT_TIME || '14:00'
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  const hour = match ? Number(match[1]) : 14
  const minute = match ? Number(match[2]) : 0
  return { hour: hour >= 0 && hour <= 23 ? hour : 14, minute: minute >= 0 && minute <= 59 ? minute : 0 }
}

/**
 * Booking даты хранятся как UTC-полночь. Для Уфы/Екатеринбурга задаём время
 * заезда в UTC+5; при смене города достаточно поменять CHECKIN_UTC_OFFSET_HOURS.
 */
export function checkinMoment(checkInDate: Date): Date {
  const { hour, minute } = checkinTimeParts()
  const offsetHours = Number(process.env.CHECKIN_UTC_OFFSET_HOURS || 5)
  return new Date(Date.UTC(
    checkInDate.getUTCFullYear(), checkInDate.getUTCMonth(), checkInDate.getUTCDate(), hour - offsetHours, minute,
  ))
}

function formatCheckin(checkInDate: Date): string {
  const { hour, minute } = checkinTimeParts()
  const date = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(checkInDate)
  return `${date}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function renderInstruction(property: {
  address: string; checkInInstructions: string; intercomCode: string; doorCode: string; mapUrl: string; wifiName: string; wifiPassword: string
}): string {
  // Пользовательский текст позволяет хранить точные правила конкретной квартиры.
  // Плейсхолдеры полезны, когда код или Wi-Fi обновились без переписывания шаблона.
  const values: Record<string, string> = {
    address: property.address,
    doorCode: property.doorCode,
    intercomCode: property.intercomCode,
    mapUrl: property.mapUrl,
    wifiName: property.wifiName,
    wifiPassword: property.wifiPassword,
  }
  if (property.checkInInstructions.trim()) {
    const rendered = property.checkInInstructions.trim().replace(/{{(address|doorCode|intercomCode|mapUrl|wifiName|wifiPassword)}}/g, (_all, key: string) => values[key] || '')
    // Avito Messenger работает с обычным текстом, поэтому Markdown-ссылку
    // превращаем в прямой URL: он остаётся кликабельным и не выглядит «кодом».
    return rendered.replace(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g, '$1')
  }

  return [
    property.intercomCode ? `✅ Код от домофона #${property.intercomCode}#` : '',
    property.doorCode ? `✅ Код доступа в квартиру: ${property.doorCode} 🔑` : '',
    property.mapUrl ? `✅ Ссылка на 2Гис:\n${property.mapUrl}` : '',
    property.wifiName ? `✅ Wi-Fi: ${property.wifiName}` : '',
    property.wifiPassword ? `Пароль: ${property.wifiPassword}` : '',
    property.address ? `Также напоминаем адрес: ${property.address}` : '',
  ].filter(Boolean).join('\n\n')
}

function isReadyForSend(instruction: string): boolean {
  return instruction.trim().length > 0
}

/** Ищет оплаченные брони, которым пора показать менеджеру карточку заселения. */
export async function requestDueCheckinApprovals(): Promise<void> {
  if (process.env.CHECKIN_DISPATCH_ENABLED !== 'true') return

  const now = new Date()
  const candidates = await prisma.booking.findMany({
    where: {
      accessUnlocked: true,
      avitoChatId: { not: '' },
      checkOut: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    },
    include: { property: true, tenant: true, checkinDispatch: true },
  })

  for (const booking of candidates) {
    const scheduledFor = new Date(checkinMoment(booking.checkIn).getTime() - FOUR_HOURS_MS)
    // Не создаём карточки для далёких и уже завершённых проживаний.
    if (now < scheduledFor || now > booking.checkOut) continue

    const instruction = renderInstruction(booking.property)
    if (!isReadyForSend(instruction)) {
      console.warn(`[checkinDispatch][${booking.tenantId}] booking=${booking.id}: нет инструкции, пропуск`)
      continue
    }

    const dispatch = booking.checkinDispatch ?? await prisma.checkinDispatch.create({
      data: { tenantId: booking.tenantId, bookingId: booking.id, scheduledFor },
    }).catch(async () => prisma.checkinDispatch.findUnique({ where: { bookingId: booking.id } }))
    if (!dispatch || dispatch.sentAt || dispatch.cancelledAt) continue
    if (dispatch.approvalRequestedAt) continue
    if (dispatch.deferredUntil && dispatch.deferredUntil > now) continue

    if (!booking.tenant.telegramBotToken || !booking.tenant.telegramChatId) {
      console.warn(`[checkinDispatch][${booking.tenantId}] Telegram не настроен, booking=${booking.id}`)
      continue
    }

    // Сначала фиксируем запрос: при следующем cron он не продублируется.
    const locked = await prisma.checkinDispatch.updateMany({
      where: { id: dispatch.id, approvalRequestedAt: null, sentAt: null, cancelledAt: null },
      data: { approvalRequestedAt: now, deferredUntil: null },
    })
    if (locked.count !== 1) continue

    await sendCheckinApprovalRequest(
      booking.tenant.telegramBotToken,
      booking.tenant.telegramChatId,
      dispatch.id,
      {
        guestName: booking.guestName,
        propertyName: booking.property.name,
        address: booking.property.address,
        checkInLabel: formatCheckin(booking.checkIn),
        instruction,
      },
    )
  }
}

export type CheckinAction = 'cis' | 'cid' | 'cic'

/** Обрабатывает подтверждение менеджера, не доверяя bookingId из callback_data. */
export async function handleCheckinAction(
  config: ConfigWithTenant,
  dispatchId: string,
  action: CheckinAction,
  actor: string,
): Promise<string> {
  const dispatch = await prisma.checkinDispatch.findUnique({
    where: { id: dispatchId },
    include: { booking: { include: { property: true } } },
  })
  if (!dispatch || dispatch.tenantId !== config.tenantId) return 'Заселение не найдено'
  if (dispatch.sentAt) return 'Инструкция уже отправлена'
  if (dispatch.cancelledAt) return 'Отправка отменена'

  if (action === 'cic') {
    await prisma.checkinDispatch.update({ where: { id: dispatch.id }, data: { cancelledAt: new Date() } })
    return `Отправка отменена · ${actor}`
  }
  if (action === 'cid') {
    await prisma.checkinDispatch.update({
      where: { id: dispatch.id },
      data: { approvalRequestedAt: null, deferredUntil: new Date(Date.now() + THIRTY_MINUTES_MS) },
    })
    return `Отложено на 30 мин · ${actor}`
  }

  const booking = dispatch.booking
  if (!booking.accessUnlocked || !booking.avitoChatId) return 'Бронь не оплачена или чат Авито не привязан'
  const instruction = renderInstruction(booking.property)
  if (!isReadyForSend(instruction)) return 'У квартиры не заполнена инструкция заселения'

  // Помечаем до внешней отправки: повторное нажатие не может выдать код дважды.
  const claimed = await prisma.checkinDispatch.updateMany({
    where: { id: dispatch.id, sentAt: null, cancelledAt: null },
    data: { sentAt: new Date(), sentBy: actor },
  })
  if (claimed.count !== 1) return 'Инструкция уже обрабатывается'

  try {
    await sendMessage(config as TenantAvitoConfig, booking.avitoChatId, instruction)
    await markAsRead(config as TenantAvitoConfig, booking.avitoChatId).catch(() => {})
    const dialogue = await getOrCreateDialogue(config.tenantId, booking.avitoChatId, booking.propertyId)
    await markMessageProcessed(dialogue.id, `bot-checkin-${dispatch.id}`, 'BOT', instruction)
    return `Инструкция отправлена · ${actor}`
  } catch (err) {
    // Возвращаем карточку в доступное состояние: менеджер увидит сетевую ошибку
    // и сможет повторить отправку только после новой карточки cron-цикла.
    await prisma.checkinDispatch.update({ where: { id: dispatch.id }, data: { sentAt: null, sentBy: '' } }).catch(() => {})
    throw err
  }
}
