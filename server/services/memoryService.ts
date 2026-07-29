import prisma from '../prisma.js'
import type { Dialogue, Message } from '@prisma/client'

export async function getOrCreateDialogue(
  tenantId: string,
  avitoChatId: string,
  propertyId?: string
): Promise<Dialogue> {
  return prisma.dialogue.upsert({
    where: { tenantId_avitoChatId: { tenantId, avitoChatId } },
    update: {},
    create: { tenantId, avitoChatId, propertyId },
  })
}

export async function updateDialogue(
  avitoChatId: string,
  tenantId: string,
  data: Partial<Pick<Dialogue, 'guestName' | 'messageCount' | 'lastMessageAt' | 'pausedUntil' | 'greetingSent' | 'summary'>>
): Promise<void> {
  await prisma.dialogue.update({
    where: { tenantId_avitoChatId: { tenantId, avitoChatId } },
    data,
  })
}

export async function isMessageProcessed(avitoMsgId: string): Promise<boolean> {
  const msg = await prisma.message.findUnique({ where: { avitoMsgId } })
  return msg !== null
}

/**
 * Атомарно регистрирует сообщение как обработанное.
 * Возвращает true, если запись создана впервые, и false, если такое
 * avitoMsgId уже существует (unique-конфликт) — это служит замком против
 * параллельной/повторной обработки одного и того же сообщения.
 */
export async function markMessageProcessed(
  dialogueId: string,
  avitoMsgId: string,
  role: 'GUEST' | 'BOT',
  content: string
): Promise<boolean> {
  try {
    await prisma.message.create({
      data: { dialogueId, avitoMsgId, role, content },
    })
    return true
  } catch (err) {
    // P2002 = unique constraint violation на avitoMsgId → уже обработано
    if ((err as { code?: string }).code === 'P2002') return false
    throw err
  }
}

/**
 * Бот «молчит» в чате, если он полностью отключён клиентом (botDisabled)
 * ИЛИ активна временная авто-пауза (pausedUntil в будущем).
 */
export async function isPaused(avitoChatId: string, tenantId: string): Promise<boolean> {
  const dialogue = await prisma.dialogue.findUnique({
    where: { tenantId_avitoChatId: { tenantId, avitoChatId } },
  })
  if (!dialogue) return false
  if (dialogue.botDisabled) return true
  if (!dialogue.pausedUntil) return false
  return dialogue.pausedUntil > new Date()
}

export async function setBotDisabled(dialogueId: string, tenantId: string, disabled: boolean): Promise<void> {
  await prisma.dialogue.update({
    where: { id: dialogueId, tenantId },
    data: { botDisabled: disabled },
  })
}

/**
 * Возвращает бота в чат: снимает и ручное отключение (botDisabled), и активную
 * авто-паузу (pausedUntil). Оба состояния снимаются вместе намеренно — менеджер
 * видит одно «бот молчит» и жмёт одну кнопку, не разбираясь, чем именно бот
 * остановлен. Без сброса pausedUntil кнопка «Включить» выглядела бы сломанной:
 * бот продолжал бы молчать до истечения 30 минут.
 */
export async function resumeDialogue(dialogueId: string, tenantId: string): Promise<void> {
  await prisma.dialogue.update({
    where: { id: dialogueId, tenantId },
    data: { botDisabled: false, pausedUntil: null },
  })
}

export async function pauseDialogue(avitoChatId: string, tenantId: string, minutes: number): Promise<void> {
  const pausedUntil = new Date(Date.now() + minutes * 60 * 1000)
  await prisma.dialogue.update({
    where: { tenantId_avitoChatId: { tenantId, avitoChatId } },
    data: { pausedUntil },
  })
}

export async function getRecentMessages(
  avitoChatId: string,
  tenantId: string,
  limit: number
): Promise<Message[]> {
  const dialogue = await prisma.dialogue.findUnique({
    where: { tenantId_avitoChatId: { tenantId, avitoChatId } },
  })
  if (!dialogue) return []

  return prisma.message.findMany({
    where: { dialogueId: dialogue.id },
    orderBy: { processedAt: 'desc' },
    take: limit,
  }).then(msgs => msgs.reverse())
}
