import prisma from '../prisma.js'
import { checkinMoment } from './checkinDispatchService.js'

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000

export type ParsedCheckinTime = { minutes: number; label: string }

/**
 * Берём время только когда гость прямо говорит именно о приезде/заселении.
 * Это защищает от фраз вроде «позвоните в 22» или «выедем в 22».
 */
export function extractCheckinTime(text: string): ParsedCheckinTime | null {
  const normalized = text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
  const intent = /(?:^|[^\p{L}])(засел[\p{L}]*|заед[\p{L}]*|заезд[\p{L}]*|приед[\p{L}]*|подъед[\p{L}]*)|будем\s+(?:у\s+вас\s+)?(?:в|к|после)/u
  if (!intent.test(normalized)) return null

  // «Заселимся в 22», «приедем к 19:30», «заедем после 18 часов».
  const time = /(?:^|\s)(?:в|к|после)\s*(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*(?:час(?:а|ов)?|ч\.?\b)?/u.exec(normalized)
  if (!time) return null
  const hour = Number(time[1])
  const minute = time[2] === undefined ? 0 : Number(time[2])
  if (hour > 23 || minute > 59) return null

  const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  return { minutes: hour * 60 + minute, label }
}

/** Сохраняет последнее ясное время заезда для ближайшей брони этого чата. */
export async function recordGuestCheckinTime(
  tenantId: string,
  avitoChatId: string,
  message: string,
): Promise<ParsedCheckinTime | null> {
  const parsed = extractCheckinTime(message)
  if (!parsed) return null

  const todayUtc = new Date()
  todayUtc.setUTCHours(0, 0, 0, 0)
  const booking = await prisma.booking.findFirst({
    where: { tenantId, avitoChatId, checkOut: { gte: todayUtc } },
    orderBy: { checkIn: 'asc' },
    select: { id: true, checkIn: true },
  })
  if (!booking) return null

  const scheduledFor = new Date(checkinMoment(booking.checkIn, parsed.minutes).getTime() - FOUR_HOURS_MS)

  await prisma.$transaction([
    prisma.booking.update({
      where: { id: booking.id },
      data: {
        checkInTimeMinutes: parsed.minutes,
        checkInTimeSource: 'GUEST_CHAT',
        checkInTimeMessage: message.trim().slice(0, 500),
      },
    }),
    // Если карточка ранее была назначена по времени по умолчанию, отменяем её
    // ожидание: планировщик создаст свежую карточку за 4 часа до нового времени.
    prisma.checkinDispatch.updateMany({
      where: { bookingId: booking.id, sentAt: null, cancelledAt: null },
      data: { scheduledFor, approvalRequestedAt: null, deferredUntil: null },
    }),
  ])
  return parsed
}
