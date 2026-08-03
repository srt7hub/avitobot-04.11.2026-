import express from 'express'
import prisma from './prisma.js'
import { initSentry, captureError } from './sentry.js'
import { getAllChats, getMessages, sendMessage, markAsRead, AvitoApiError, type TenantAvitoConfig } from './services/avitoService.js'
import { buildSystemPrompt, generateReply, extractTopics } from './services/aiService.js'
import { sanitizeAiResponse } from './services/responseFilter.js'
import {
  getOrCreateDialogue,
  updateDialogue,
  markMessageProcessed,
  isMessageProcessed,
  isPaused,
  pauseDialogue,
  getRecentMessages,
} from './services/memoryService.js'
import { getFaqForProperty } from './services/faqService.js'
import { findBookingForChat } from './services/bookingService.js'
import { isBookingSyncConfigured, syncBookingsForTenant, sendPaymentConfirmation } from './services/avitoBookingService.js'
import { syncTenantCalendars } from './services/calendarService.js'
import { isAiSilentPhase } from './utils/guestPhase.js'
import { sendHumanTakeoverAlert, sendDialogueNotification, sendUnknownAnswerAlert, sendOpsAlert, sendPausedMessageNotification } from './services/telegramService.js'
import { pollTelegramCommands } from './services/telegramCommandService.js'
import { maskPii } from './services/piiService.js'
import { isPaymentStatusIntent, isSmsIntent, isAckIntent } from './constants/intents.js'
import type { AvitoChat, AvitoMessage } from './services/avitoService.js'
import type { TenantAvitoConfig as PrismaTenantAvitoConfig, Tenant } from '@prisma/client'

const OPERATOR_KEYWORDS = ['оператор', 'человек', 'живой', 'менеджер', 'поговорить с человеком']
const HUMAN_TAKEOVER_REPLY = 'Передаю вас менеджеру, он свяжется в ближайшее время'
const PAUSE_MINUTES = 30

// Детерминированные ответы на вопросы, где LLM нельзя доверять.
// Бот НЕ знает реального статуса оплаты (нет модели Booking), поэтому даёт
// безопасный нейтральный ответ вместо выдуманного «оплата подтверждена».
const PAYMENT_STATUS_REPLY = 'Проверьте, пожалуйста, статус заявки в приложении Авито — там отображается актуальное состояние брони и оплаты'
const SMS_REPLY = 'Уведомление придёт в ближайшее время'
const ACK_REPLY = 'Если возникнут вопросы — пишите, всегда на связи'

// Служебные строки, которые Авито присылает как обычный text-контент
// (удаление сообщения и т.п.). На них отвечать НЕ нужно.
const SERVICE_MESSAGE_TEXTS = [
  'сообщение удалено',
]

// Фразы в system-сообщениях Авито, означающие новую бронь/предоплату.
const BOOKING_KEYWORDS = [
  'новая бронь',
  'новая заявка',
  'создана заявка',
  'заявка на бронирование',
  'бронирование создано',
  'запрос на бронирование',
]

// Не реагируем на system-сообщения старше этого возраста (защита от того,
// что после рестарта бота старая "новая бронь" триггерит приветствие заново).
const BOOKING_MAX_AGE_MS = 2 * 60 * 60 * 1000 // 2 часа

// Окно «недавней активности» чата: getMessages вызываем только для чатов, у
// которых chat.updated за это время. Защищает rate-limit Авито и покрывает кейс
// «менеджер прочитал чат раньше бота». Окно с большим запасом перекрывает тик
// поллинга (POLL_INTERVAL_MS) — на случай, если менеджер читает чат не сразу.
const ACTIVE_CHAT_WINDOW_MS = 30 * 60 * 1000 // 30 минут

function isSystemMessage(message: AvitoMessage): boolean {
  return message.type === 'system' || String(message.author_id) === '0'
}

// Сообщения, которые НЕЛЬЗЯ проглатывать при схлопывании пачки: системные
// (новая бронь — критичный момент) и явный запрос оператора. Их обрабатываем
// полноценно, даже если они не последние в пачке.
function needsImmediateHandling(message: AvitoMessage): boolean {
  if (isSystemMessage(message)) return true
  return isOperatorRequest(message.content?.text ?? '')
}

function isNewBookingMessage(text: string): boolean {
  const lower = text.toLowerCase()
  return BOOKING_KEYWORDS.some(kw => lower.includes(kw))
}

function isOperatorRequest(text: string): boolean {
  const lower = text.toLowerCase()
  return OPERATOR_KEYWORDS.some(kw => lower.includes(kw))
}

// Отвечаем только на реальные текстовые сообщения гостя.
// Отсекаем: не-текстовые типы (картинки/голос/локация — у них пустой text,
// но type != text) и системные строки вроде "Сообщение удалено".
function isServiceMessage(message: AvitoMessage, text: string): boolean {
  if (message.type && message.type !== 'text') return true
  const normalized = text.trim().toLowerCase()
  return SERVICE_MESSAGE_TEXTS.includes(normalized)
}

// Отправляет детерминированный (не-AI) ответ: шлёт в Авито, помечает прочитанным,
// записывает bot-сообщение, инкрементит счётчики и уведомляет оператора в Telegram.
// Используется для перехваченных интентов (оплата/SMS/ack), где ответ программный.
async function sendProgrammaticReply(
  config: PrismaTenantAvitoConfig & { tenant: Tenant },
  avitoConfig: TenantAvitoConfig,
  dialogueId: string,
  avitoChatId: string,
  guestName: string,
  guestMessage: string,
  reply: string,
  botMsgIdPrefix: string
): Promise<void> {
  const { tenantId, tenant } = config

  await sendMessage(avitoConfig, avitoChatId, reply)
  await markAsRead(avitoConfig, avitoChatId)
  await markMessageProcessed(dialogueId, `${botMsgIdPrefix}-${Date.now()}`, 'BOT', reply)

  await prisma.botSession.upsert({
    where: { tenantId },
    update: { messagesDay: { increment: 1 }, messagesWeek: { increment: 1 }, messagesMonth: { increment: 1 }, lastPollAt: new Date(), errorCount: 0 },
    create: { tenantId, messagesDay: 1, messagesWeek: 1, messagesMonth: 1, isRunning: true },
  })

  if (tenant.telegramBotToken && tenant.telegramChatId) {
    await sendDialogueNotification(tenant.telegramBotToken, tenant.telegramChatId, avitoChatId, guestName, guestMessage, reply, dialogueId)
  }
}

async function processMessage(
  config: PrismaTenantAvitoConfig & { tenant: Tenant },
  chat: AvitoChat,
  message: AvitoMessage,
  // recordOnly: только зафиксировать сообщение в истории (без ответа). Нужно при
  // схлопывании пачки сообщений гостя — отвечаем один раз на последнее.
  recordOnly = false
): Promise<void> {
  const { tenantId, tenant } = config
  const avitoChatId = chat.id
  const msgText = message.content?.text ?? ''
  const avitoMsgId = String(message.id)

  if (!msgText.trim()) return

  // ПДн-защита: маскируем телефоны/email гостя ОДИН раз. Маскированную версию
  // используем для всего, что покидает рантайм (хранение в БД, пересылка в
  // Telegram, история для AI). Сырой msgText — только для pattern-матчинга
  // интентов, где ПДн не влияют на результат. См. [[piiService]].
  const maskedText = maskPii(msgText)

  const property = await prisma.property.findFirst({
    where: { tenantId, avitoItemId: chat.item_id, isActive: true },
  })

  // ─── Системные сообщения Авито (новая бронь / предоплата) ───────────────────
  // Обрабатываем ДО фильтра служебных сообщений и до cutoff: момент брони
  // критичен. На обычные системные строки (не бронь) — просто молчим.
  if (isSystemMessage(message)) {
    if (!isNewBookingMessage(msgText)) {
      console.log(`[bot][${tenantId}] System message (not booking) in chat ${avitoChatId}, ignoring`)
      return
    }

    const dialogue = await getOrCreateDialogue(tenantId, avitoChatId, property?.id)

    // Дедуп: помечаем системное сообщение обработанным (замок от повторов)
    const isNewSys = await markMessageProcessed(dialogue.id, avitoMsgId, 'GUEST', maskedText)
    if (!isNewSys) return

    // Guard: приветствие уже отправлялось — не дублируем (рестарт/повторное обнаружение)
    if (dialogue.greetingSent) {
      console.log(`[bot][${tenantId}] New booking in chat ${avitoChatId}, but greeting already sent — skip`)
      return
    }

    // Guard по возрасту: старое system-сообщение не должно слать приветствие заново
    const ageMs = message.created ? Date.now() - message.created * 1000 : 0
    const isFresh = ageMs < BOOKING_MAX_AGE_MS

    const avitoConfig: TenantAvitoConfig = {
      id: config.id, tenantId: config.tenantId, avitoClientId: config.avitoClientId,
      avitoClientSecret: config.avitoClientSecret, avitoUserId: config.avitoUserId,
      accessToken: config.accessToken, refreshToken: config.refreshToken,
      tokenExpiresAt: config.tokenExpiresAt, pollingEnabled: config.pollingEnabled,
      pollingStartedAt: config.pollingStartedAt,
    }

    const guestFirstName = (chat.users?.find(u => u.id !== Number(config.avitoUserId))?.name ?? '').split(' ')[0]
    const greeting = guestFirstName
      ? `Здравствуйте, ${guestFirstName}!\nСпасибо, что выбрали нашу компанию. Мы подготовили для Вас чистые и комфортные апартаменты 🙏🏻\n\nДля зафиксирования дат за Вами необходимо внести предоплату в Авито`
      : `Здравствуйте!\nСпасибо, что выбрали нашу компанию. Мы подготовили для Вас чистые и комфортные апартаменты 🙏🏻\n\nДля зафиксирования дат за Вами необходимо внести предоплату в Авито`

    if (isFresh) {
      await sendMessage(avitoConfig, avitoChatId, greeting)
      await markAsRead(avitoConfig, avitoChatId)
      const botMsgId = `bot-booking-${Date.now()}`
      await markMessageProcessed(dialogue.id, botMsgId, 'BOT', greeting)
      await updateDialogue(avitoChatId, tenantId, { greetingSent: true, lastMessageAt: new Date() })
      console.log(`[bot][${tenantId}] New booking in chat ${avitoChatId} — greeting sent`)

      // Уведомления в Telegram клиента + OPS
      const guestName = chat.users?.find(u => u.id !== Number(config.avitoUserId))?.name ?? 'Гость'
      if (tenant.telegramBotToken && tenant.telegramChatId) {
        await sendDialogueNotification(tenant.telegramBotToken, tenant.telegramChatId, avitoChatId, guestName, '🆕 Новая бронь', greeting, dialogue.id)
      }
      await sendOpsAlert(`[${tenantId}] Новая бронь в чате ${avitoChatId} (гость: ${guestName})`)
    } else {
      // Старое сообщение — фиксируем greetingSent чтобы не среагировать позже, без отправки
      await updateDialogue(avitoChatId, tenantId, { greetingSent: true })
      console.log(`[bot][${tenantId}] Stale booking message in chat ${avitoChatId} (age ${Math.round(ageMs / 60000)}min) — marked, no greeting`)
    }
    return
  }

  // Игнорируем служебные/не-текстовые сообщения (удаление, картинки, голос и т.п.)
  if (isServiceMessage(message, msgText)) {
    console.log(`[bot][${tenantId}] Skip service message in chat ${avitoChatId}: "${maskedText.slice(0, 40)}"`)
    return
  }

  // Get or create dialogue
  const dialogue = await getOrCreateDialogue(tenantId, avitoChatId, property?.id)

  // Атомарный дедуп: попытка создать запись сообщения служит замком.
  // Если false — это сообщение уже обрабатывается/обработано, выходим.
  const isNew = await markMessageProcessed(dialogue.id, avitoMsgId, 'GUEST', maskedText)
  if (!isNew) return
  await updateDialogue(avitoChatId, tenantId, {
    messageCount: dialogue.messageCount + 1,
    lastMessageAt: new Date(),
    guestName: chat.users?.find(u => u.id !== Number(config.avitoUserId))?.name ?? '',
  })

  const avitoConfig: TenantAvitoConfig = {
    id: config.id,
    tenantId: config.tenantId,
    avitoClientId: config.avitoClientId,
    avitoClientSecret: config.avitoClientSecret,
    avitoUserId: config.avitoUserId,
    accessToken: config.accessToken,
    refreshToken: config.refreshToken,
    tokenExpiresAt: config.tokenExpiresAt,
    pollingEnabled: config.pollingEnabled,
    pollingStartedAt: config.pollingStartedAt,
  }

  // Схлопывание пачки: это не последнее сообщение гостя в тике — уже записали
  // его в историю выше (markMessageProcessed), теперь просто помечаем прочитанным
  // и выходим. Ответ сформируется на последнее сообщение с учётом этого контекста.
  if (recordOnly) {
    await markAsRead(avitoConfig, avitoChatId)
    // Если чат на паузе — менеджер должен видеть КАЖДОЕ сообщение гостя, в т.ч.
    // промежуточные из пачки (иначе они потеряются: ответа-то всё равно нет).
    if (tenant.telegramBotToken && tenant.telegramChatId && await isPaused(avitoChatId, tenantId)) {
      const pausedGuestName = chat.users?.find(u => u.id !== Number(config.avitoUserId))?.name ?? 'Гость'
      await sendPausedMessageNotification(tenant.telegramBotToken, tenant.telegramChatId, avitoChatId, pausedGuestName, maskedText, dialogue.id)
    }
    return
  }

  // Предохранитель: НЕ отвечаем на сообщения, пришедшие до момента запуска
  // поллинга для этого тенанта (бэклог накопившихся непрочитанных чатов).
  // message.created — unix-время в секундах.
  const cutoff = config.pollingStartedAt
  if (cutoff && message.created && message.created * 1000 < cutoff.getTime()) {
    await markAsRead(avitoConfig, avitoChatId)
    console.log(`[bot][${tenantId}] Skip pre-cutoff message in chat ${avitoChatId} (created ${new Date(message.created * 1000).toISOString()})`)
    return
  }

  // Human Takeover check
  if (isOperatorRequest(msgText)) {
    await sendMessage(avitoConfig, avitoChatId, HUMAN_TAKEOVER_REPLY)
    await markAsRead(avitoConfig, avitoChatId)

    const botMsgId = `bot-takeover-${Date.now()}`
    await markMessageProcessed(dialogue.id, botMsgId, 'BOT', HUMAN_TAKEOVER_REPLY)
    await pauseDialogue(avitoChatId, tenantId, PAUSE_MINUTES)

    // Alert client via their own Telegram bot
    if (tenant.telegramBotToken && tenant.telegramChatId) {
      const guestName = chat.users?.find(u => u.id !== Number(config.avitoUserId))?.name ?? 'Гость'
      await sendHumanTakeoverAlert(
        tenant.telegramBotToken,
        tenant.telegramChatId,
        avitoChatId,
        guestName,
        dialogue.id
      )
    }

    await prisma.botSession.upsert({
      where: { tenantId },
      update: { messagesDay: { increment: 1 }, messagesWeek: { increment: 1 }, messagesMonth: { increment: 1 }, lastPollAt: new Date() },
      create: { tenantId, messagesDay: 1, messagesWeek: 1, messagesMonth: 1, isRunning: true },
    })
    return
  }

  // Check if paused (human takeover active)
  if (await isPaused(avitoChatId, tenantId)) {
    // Помечаем прочитанным, чтобы пауза не держала чат в unread бесконечно
    await markAsRead(avitoConfig, avitoChatId)
    // Бот молчит, но менеджер должен видеть, что пишет гость — дублируем в Telegram.
    if (tenant.telegramBotToken && tenant.telegramChatId) {
      const pausedGuestName = chat.users?.find(u => u.id !== Number(config.avitoUserId))?.name ?? 'Гость'
      await sendPausedMessageNotification(tenant.telegramBotToken, tenant.telegramChatId, avitoChatId, pausedGuestName, maskedText, dialogue.id)
    }
    return
  }

  // ─── Программные интенты (перехват ДО AI) ──────────────────────────────────
  // Эти вопросы требуют детерминированного ответа: LLM на них галлюцинирует
  // (например, выдумывает «оплата подтверждена»). Отвечаем шаблоном и выходим.
  const textLower = msgText.toLowerCase()
  const guestName = chat.users?.find(u => u.id !== Number(config.avitoUserId))?.name ?? 'Гость'

  if (isPaymentStatusIntent(textLower)) {
    console.log(`[bot][${tenantId}] Payment-status intent in chat ${avitoChatId} → programmatic reply`)
    await sendProgrammaticReply(config, avitoConfig, dialogue.id, avitoChatId, guestName, maskedText, PAYMENT_STATUS_REPLY, 'bot-payment')
    return
  }

  if (isSmsIntent(textLower)) {
    console.log(`[bot][${tenantId}] SMS intent in chat ${avitoChatId} → programmatic reply`)
    await sendProgrammaticReply(config, avitoConfig, dialogue.id, avitoChatId, guestName, maskedText, SMS_REPLY, 'bot-sms')
    return
  }

  if (isAckIntent(textLower)) {
    console.log(`[bot][${tenantId}] Ack intent in chat ${avitoChatId} → programmatic reply`)
    await sendProgrammaticReply(config, avitoConfig, dialogue.id, avitoChatId, guestName, maskedText, ACK_REPLY, 'bot-ack')
    return
  }

  // Определяем бронь и фазу гостя — от неё зависит гейтинг чувствительных данных
  // и поведение бота. Без брони фаза = NO_BOOKING, бот работает как раньше.
  const bookingResult = await findBookingForChat(tenantId, avitoChatId, property?.id)
  const phase = bookingResult?.phase ?? 'NO_BOOKING'

  // Тихие фазы (сразу после выезда / давний гость): AI не отвечает сам — зовём оператора.
  if (isAiSilentPhase(phase)) {
    console.log(`[bot][${tenantId}] Phase ${phase} in chat ${avitoChatId} — AI молчит, эскалация оператору`)
    await markAsRead(avitoConfig, avitoChatId)
    if (tenant.telegramBotToken && tenant.telegramChatId) {
      // Тихая фаза паузу не ставит — бот формально активен, поэтому «Выключить».
      await sendUnknownAnswerAlert(tenant.telegramBotToken, tenant.telegramChatId, avitoChatId, guestName, maskedText, `— фаза ${phase}, нужен оператор —`, dialogue.id, false)
    }
    return
  }

  // Build chat history for AI
  const recentMsgs = await getRecentMessages(avitoChatId, tenantId, 10)
  const chatHistory = recentMsgs.map(m => ({
    role: m.role === 'GUEST' ? ('user' as const) : ('assistant' as const),
    content: m.content,
  }))

  // Load FAQ
  const faqEntries = await getFaqForProperty(tenantId, property?.id)

  // Build system prompt (с фазой и чувствительными данными объекта — гейтинг внутри)
  const systemPrompt = buildSystemPrompt({
    botName: tenant.botName,
    property: property
      ? {
          name: property.name,
          address: property.address,
          description: property.description,
          doorCode: property.doorCode,
          wifiName: property.wifiName,
          wifiPassword: property.wifiPassword,
          checkInInstructions: property.checkInInstructions,
        }
      : null,
    faqEntries: faqEntries.map(f => ({ question: f.question, answer: f.answer })),
    memorySummary: dialogue.summary,
    phase,
    customPrompt: tenant.customPrompt,
  })

  // Generate AI reply
  const rawReply = await generateReply(chatHistory, systemPrompt)
  const { text: filteredReply, warnings } = sanitizeAiResponse(rawReply)

  if (warnings.length > 0) {
    console.warn(`[bot][${tenantId}] Response filter warnings for chat ${avitoChatId}:`, warnings)
  }

  // Send to Avito
  await sendMessage(avitoConfig, avitoChatId, filteredReply)
  await markAsRead(avitoConfig, avitoChatId)

  const botMsgId = `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await markMessageProcessed(dialogue.id, botMsgId, 'BOT', filteredReply)

  // Память диалога: извлекаем тему и дописываем в summary (асинхронно, не блокируем
  // отправку). Best-effort — сбой извлечения не влияет на основной ответ.
  void (async () => {
    try {
      const topic = await extractTopics(maskedText)
      if (!topic) return
      const existing = dialogue.summary || ''
      // Не дублируем уже зафиксированную тему; лимит 300 символов на summary.
      if (existing.toLowerCase().includes(topic.toLowerCase())) return
      const updated = (existing ? `${existing}, ${topic}` : topic).slice(0, 300)
      await updateDialogue(avitoChatId, tenantId, { summary: updated })
    } catch (err) {
      console.warn(`[bot][${tenantId}] extractTopics/summary update failed for chat ${avitoChatId}:`, err)
    }
  })()

  await prisma.botSession.upsert({
    where: { tenantId },
    update: { messagesDay: { increment: 1 }, messagesWeek: { increment: 1 }, messagesMonth: { increment: 1 }, lastPollAt: new Date(), errorCount: 0 },
    create: { tenantId, messagesDay: 1, messagesWeek: 1, messagesMonth: 1, isRunning: true },
  })

  // Бот не знает ответа («Уточню и вернусь») — ставим паузу на 30 мин, чтобы
  // менеджер успел ответить сам и бот не отвечал «Уточню и вернусь» снова.
  // Пауза не зависит от настройки Telegram.
  const isUnknown = filteredReply.includes('Уточню и вернусь с ответом')
  if (isUnknown) {
    await pauseDialogue(avitoChatId, tenantId, PAUSE_MINUTES)
  }

  // Telegram notifications
  if (tenant.telegramBotToken && tenant.telegramChatId) {
    if (isUnknown) {
      // isUnknown → выше уже поставлена авто-пауза на 30 мин, бот молчит.
      await sendUnknownAnswerAlert(tenant.telegramBotToken, tenant.telegramChatId, avitoChatId, guestName, maskedText, filteredReply, dialogue.id, true)
    } else {
      await sendDialogueNotification(tenant.telegramBotToken, tenant.telegramChatId, avitoChatId, guestName, maskedText, filteredReply, dialogue.id)
    }
  }

  console.log(`[bot][${tenantId}] Replied to chat ${avitoChatId}: "${filteredReply.slice(0, 60)}..."`)
}

// ─── Runtime-состояние блокировок Avito API (в памяти, per-tenant) ──────────
// 402 — тариф Авито Pro не поддерживает чтение сообщений: поллинг тенанта
// останавливается до рестарта процесса или ручного включения poll'а в панели.
// 429 — rate-limit: тенант пропускается до истечения retry-after.
const planBlockedTenants = new Set<string>()
const rateLimitedUntil = new Map<string, number>() // tenantId → timestamp (ms)

// Re-throw'им 402/429 наружу, чтобы их обработал tenant-level catch и остановил
// поллинг тенанта; остальные ошибки чата глотаем (один битый чат не валит цикл).
function isFatalAvitoError(err: unknown): err is AvitoApiError {
  return err instanceof AvitoApiError && (err.status === 402 || err.status === 429)
}

async function processTenant(config: PrismaTenantAvitoConfig & { tenant: Tenant }): Promise<void> {
  const { tenantId } = config

  // Тариф заблокирован (402) — тихо пропускаем тенант до рестарта/ре-энейбла.
  if (planBlockedTenants.has(tenantId)) return

  // Rate-limit (429) — ждём истечения retry-after.
  const blockedUntil = rateLimitedUntil.get(tenantId)
  if (blockedUntil && Date.now() < blockedUntil) return
  if (blockedUntil) rateLimitedUntil.delete(tenantId)

  // Предохранитель первого запуска: фиксируем момент старта поллинга один раз.
  // Все сообщения старше этого момента будут проигнорированы (см. processMessage).
  if (!config.pollingStartedAt) {
    const now = new Date()
    await prisma.tenantAvitoConfig.update({
      where: { tenantId },
      data: { pollingStartedAt: now },
    })
    config.pollingStartedAt = now
    console.log(`[bot][${tenantId}] First poll — cutoff set to ${now.toISOString()}, backlog will be skipped`)
  }

  const avitoConfig: TenantAvitoConfig = {
    id: config.id,
    tenantId: config.tenantId,
    avitoClientId: config.avitoClientId,
    avitoClientSecret: config.avitoClientSecret,
    avitoUserId: config.avitoUserId,
    accessToken: config.accessToken,
    refreshToken: config.refreshToken,
    tokenExpiresAt: config.tokenExpiresAt,
    pollingEnabled: config.pollingEnabled,
    pollingStartedAt: config.pollingStartedAt,
  }

  try {
    // Тянем ВСЕ чаты (не только unread_only): чат, который менеджер открыл и
    // прочитал в Авито, выпадает из unread-списка — но в нём могут быть сообщения,
    // которые бот ещё не обработал (менеджер прочитал их раньше бота). Чтобы не
    // дёргать getMessages по всем чатам каждый тик (rate-limit Авито), опрашиваем
    // только недавно активные — по полю chat.updated в окне ACTIVE_CHAT_WINDOW_MS.
    // ВАЖНО: фильтруем по `updated`, а НЕ по last_message.created. Системные
    // сообщения Авито (в т.ч. «У вас новая бронь») НЕ становятся last_message в
    // списке чатов, но обновляют `updated`. Фильтр по last_message их пропускал —
    // бот не видел новые брони, если менеджер успевал прочитать чат. См. дедуп ниже.
    const chats = await getAllChats(avitoConfig, false)
    const activeSince = Date.now() - ACTIVE_CHAT_WINDOW_MS
    const activeChats = chats.filter(
      c => Math.max(c.updated ?? 0, c.last_message?.created ?? 0) * 1000 >= activeSince
    )

    for (const chat of activeChats) {
      try {
        const messages = await getMessages(avitoConfig, chat.id)

        // «Новые» сообщения определяем по СВОЕЙ истории (таблица Message), а не по
        // isRead от Авито. Причина: менеджер, открыв диалог в Авито, помечает
        // сообщения прочитанными РАНЬШЕ, чем бот доходит до них в своём тике —
        // тогда фильтр по isRead навсегда их пропускает, и бот молчит. Опираемся
        // на avitoMsgId: сообщение «новое», пока оно не записано в Message.
        // Дедуп при записи (markMessageProcessed) остаётся вторым замком от гонок.
        // Авито отдаёт сообщения от новых к старым — разворачиваем в хронологию,
        // чтобы isLast ниже означал действительно ПОСЛЕДНее по времени сообщение.
        const candidates = messages
          .filter(m => m.author_id !== Number(config.avitoUserId))
          .sort((a, b) => (a.created ?? 0) - (b.created ?? 0))
        const newFlags = await Promise.all(
          candidates.map(m => isMessageProcessed(String(m.id)).then(done => !done))
        )
        const unread = candidates.filter((_, idx) => newFlags[idx])

        // Схлопываем пачку: если гость прислал несколько сообщений подряд (бот
        // увидел их за один тик), отвечаем ОДИН раз — на последнее, с учётом
        // предыдущих в истории. Иначе бот дублирует ответ на каждое сообщение.
        // Системные сообщения (новая бронь) и запросы оператора при этом не
        // должны проглатываться, поэтому их обрабатываем полноценно всегда.
        for (let i = 0; i < unread.length; i++) {
          const message = unread[i]
          const isLast = i === unread.length - 1
          // Не-последние обычные сообщения только фиксируем в истории (recordOnly),
          // не отвечаем. Системные/оператор — обрабатываем полноценно (внутри они
          // сами решают, как реагировать).
          const recordOnly = !isLast && !needsImmediateHandling(message)
          await processMessage(config, chat, message, recordOnly)
        }
      } catch (err) {
        // 402/429 — фатально для всего тенанта: пробрасываем наружу.
        if (isFatalAvitoError(err)) throw err
        console.error(`[bot][${tenantId}] Error processing chat ${chat.id}:`, err)
      }
    }

    await prisma.botSession.upsert({
      where: { tenantId },
      update: { isRunning: true, lastPollAt: new Date(), errorCount: 0 },
      create: { tenantId, isRunning: true, lastPollAt: new Date() },
    })
  } catch (err) {
    // ─── 402: тариф Авито не поддерживает чтение сообщений ─────────────────────
    if (err instanceof AvitoApiError && err.status === 402) {
      planBlockedTenants.add(tenantId)
      console.error(`[bot][${tenantId}] ⚠️  Avito API 402 — тариф заблокирован. Поллинг тенанта остановлен.`)
      await prisma.botSession.upsert({
        where: { tenantId },
        update: { isRunning: false, lastError: 'Avito API 402: тариф Pro не поддерживает чтение сообщений' },
        create: { tenantId, isRunning: false, lastError: 'Avito API 402: тариф Pro не поддерживает чтение сообщений' },
      })
      await sendOpsAlert(`[${tenantId}] ⚠️ Avito API заблокирован (402): тариф Pro не поддерживает чтение сообщений. Автоответы остановлены до проверки тарифа.`)
      return
    }

    // ─── 429: rate-limit — пропускаем тенант до истечения retry-after ──────────
    if (err instanceof AvitoApiError && err.status === 429) {
      const retryAfterSec = err.retryAfter ?? 10
      rateLimitedUntil.set(tenantId, Date.now() + retryAfterSec * 1000)
      console.warn(`[bot][${tenantId}] Avito API 429 — rate-limited, пауза ${retryAfterSec}s`)
      return
    }

    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`[bot][${tenantId}] Poll error:`, errorMsg)

    const session = await prisma.botSession.upsert({
      where: { tenantId },
      update: { errorCount: { increment: 1 }, lastError: errorMsg.slice(0, 500) },
      create: { tenantId, errorCount: 1, lastError: errorMsg.slice(0, 500) },
    })

    if (session.errorCount >= 5) {
      await sendOpsAlert(`[${tenantId}] Bot error count=${session.errorCount}: ${errorMsg.slice(0, 200)}`)
    }
  }
}

async function pollAllTenants(): Promise<void> {
  try {
    const configs = await prisma.tenantAvitoConfig.findMany({
      where: { pollingEnabled: true, tenant: { status: 'ACTIVE' } },
      include: { tenant: true },
    })

    // Если оператор отключил поллинг тенанта (он выпал из active-выборки), снимаем
    // его 402-блокировку: повторное включение в панели возобновит работу без рестарта.
    const activeIds = new Set(configs.map(c => c.tenantId))
    for (const blockedId of planBlockedTenants) {
      if (!activeIds.has(blockedId)) {
        planBlockedTenants.delete(blockedId)
        console.log(`[bot][${blockedId}] Поллинг был отключён оператором — снимаем 402-блокировку`)
      }
    }

    if (configs.length === 0) return

    console.log(`[bot] Polling ${configs.length} active tenant(s)...`)
    await Promise.allSettled(configs.map(config => processTenant(config)))
  } catch (err) {
    console.error('[bot] pollAllTenants error:', err)
  }
}

// Собирает TenantAvitoConfig (для messenger-вызовов) из prisma-конфига тенанта.
function toAvitoConfig(config: PrismaTenantAvitoConfig): TenantAvitoConfig {
  return {
    id: config.id,
    tenantId: config.tenantId,
    avitoClientId: config.avitoClientId,
    avitoClientSecret: config.avitoClientSecret,
    avitoUserId: config.avitoUserId,
    accessToken: config.accessToken,
    refreshToken: config.refreshToken,
    tokenExpiresAt: config.tokenExpiresAt,
    pollingEnabled: config.pollingEnabled,
    pollingStartedAt: config.pollingStartedAt,
  }
}

// ─── Avito STR Booking sync ──────────────────────────────────────────────────
// Отдельный, более редкий цикл: realty API тяжелее и rate-limited, чем messenger.
// Тянет брони, ловит переход оплаты (prepaidAmount 0 → >0) и шлёт подтверждение.
const BOOKING_SYNC_INTERVAL_MS = Number(process.env.BOOKING_SYNC_INTERVAL_MS) || 5 * 60_000
let bookingSyncTimer: NodeJS.Timeout | null = null

async function runBookingSync(): Promise<void> {
  try {
    const configs = await prisma.tenantAvitoConfig.findMany({
      where: { pollingEnabled: true, tenant: { status: 'ACTIVE' } },
      include: { tenant: true },
    })
    if (configs.length === 0) return

    for (const config of configs) {
      try {
        const avitoConfig = toAvitoConfig(config)
        const { synced, errors, newlyPaid } = await syncBookingsForTenant(avitoConfig)
        if (synced || errors || newlyPaid.length) {
          console.log(`[bookingSync][${config.tenantId}] synced=${synced} errors=${errors} newlyPaid=${newlyPaid.length}`)
        }
        for (const booking of newlyPaid) {
          await sendPaymentConfirmation({ ...avitoConfig, tenant: config.tenant }, booking).catch(err =>
            console.error(`[bookingSync][${config.tenantId}] sendPaymentConfirmation failed:`, err),
          )
        }
      } catch (err) {
        console.error(`[bookingSync][${config.tenantId}] sync error:`, err)
      }
    }
  } catch (err) {
    console.error('[bookingSync] runBookingSync error:', err)
  }
}

async function bookingSyncLoop(): Promise<void> {
  if (stopped) return
  try {
    await runBookingSync()
  } catch (err) {
    console.error('[bookingSync] loop error:', err)
  } finally {
    if (!stopped) bookingSyncTimer = setTimeout(bookingSyncLoop, BOOKING_SYNC_INTERVAL_MS)
  }
}

// ─── iCal-синхронизация календарей ───────────────────────────────────────────
// Тянет занятость с других площадок (Яндекс Путешествия и т.п.) и складывает
// в CalendarBlock. Наши брони уезжают обратно через экспортный .ics, который
// площадки забирают сами. Интервал 30 минут: площадки всё равно обновляют
// свои календари не чаще раза в час, чаще дёргать смысла нет.
const CALENDAR_SYNC_INTERVAL_MS = Number(process.env.CALENDAR_SYNC_INTERVAL_MS) || 30 * 60_000
let calendarSyncTimer: NodeJS.Timeout | null = null

async function runCalendarSync(): Promise<void> {
  try {
    const tenants = await prisma.tenant.findMany({
      where: { status: 'ACTIVE', calendarSyncs: { some: { isActive: true, importUrl: { not: '' } } } },
      select: { id: true },
    })

    for (const { id } of tenants) {
      try {
        const results = await syncTenantCalendars(id)
        const failed = results.filter(r => !r.ok)
        if (results.length) {
          console.log(`[calendarSync][${id}] feeds=${results.length} failed=${failed.length}`)
        }
        for (const f of failed) {
          console.error(`[calendarSync][${id}] ${f.platform}: ${f.error}`)
        }
      } catch (err) {
        console.error(`[calendarSync][${id}] sync error:`, err)
      }
    }
  } catch (err) {
    console.error('[calendarSync] runCalendarSync error:', err)
  }
}

async function calendarSyncLoop(): Promise<void> {
  if (stopped) return
  try {
    await runCalendarSync()
  } catch (err) {
    console.error('[calendarSync] loop error:', err)
  } finally {
    if (!stopped) calendarSyncTimer = setTimeout(calendarSyncLoop, CALENDAR_SYNC_INTERVAL_MS)
  }
}

// ─── Telegram-команды (нажатия inline-кнопок) ────────────────────────────────
// Отдельный быстрый цикл: реакция на кнопку должна быть почти мгновенной, тогда
// как поллинг Авито идёт раз в 30с. Опрос лёгкий — getUpdates без блокировки.
const TG_COMMAND_INTERVAL_MS = Number(process.env.TG_COMMAND_INTERVAL_MS) || 3_000
let tgCommandTimer: NodeJS.Timeout | null = null

async function telegramCommandLoop(): Promise<void> {
  if (stopped) return
  try {
    await pollTelegramCommands()
  } catch (err) {
    console.error('[tgCmd] loop error:', err)
  } finally {
    if (!stopped) tgCommandTimer = setTimeout(telegramCommandLoop, TG_COMMAND_INTERVAL_MS)
  }
}

const POLL_INTERVAL_MS = 30_000
let isPolling = false
let stopped = false
let pollTimer: NodeJS.Timeout | null = null
// Время последнего завершённого цикла поллинга — используется /health для
// детекта «зависшего» бота (процесс online в PM2, но цикл не крутится).
let lastPollFinishedAt = Date.now()

// Самопланирующийся цикл: следующий поллинг стартует только после завершения
// текущего, что исключает наложение циклов и двойную обработку сообщений.
async function pollLoop(): Promise<void> {
  if (stopped) return
  if (isPolling) return
  isPolling = true
  try {
    await pollAllTenants()
  } catch (err) {
    console.error('[bot] pollLoop error:', err)
  } finally {
    lastPollFinishedAt = Date.now()
    isPolling = false
    if (!stopped) pollTimer = setTimeout(pollLoop, POLL_INTERVAL_MS)
  }
}

// ─── /health — лёгкий HTTP-эндпоинт для watchdog и внешнего мониторинга ──────
// Возвращает 200 если последний цикл поллинга завершился недавно, иначе 503 —
// так watchdog отличает живой бот от зависшего, а не только «процесс запущен».
function startHealthServer(): void {
  const port = Number(process.env.BOT_HEALTH_PORT) || 3011
  const app = express()
  app.get('/health', (_req, res) => {
    const ageMs = Date.now() - lastPollFinishedAt
    const stale = ageMs > POLL_INTERVAL_MS * 3 // 3 пропущенных цикла → нездоров
    res.status(stale ? 503 : 200).json({
      status: stale ? 'stale' : 'ok',
      lastPollAgoMs: ageMs,
      planBlockedTenants: planBlockedTenants.size,
    })
  })
  app.listen(port, '127.0.0.1', () => {
    console.log(`[bot] Health endpoint on http://127.0.0.1:${port}/health`)
  })
}

// ─── Глобальные обработчики необработанных ошибок ────────────────────────────
process.on('uncaughtException', (err: Error) => {
  console.error('[bot][FATAL] uncaughtException:', err)
  captureError(err, { component: 'avito-bot:uncaughtException' })
  // Выходим с ошибкой — PM2 перезапустит процесс в чистом состоянии.
  process.exit(1)
})

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[bot][FATAL] unhandledRejection:', reason)
  captureError(reason instanceof Error ? reason : new Error(String(reason)), { component: 'avito-bot:unhandledRejection' })
})

async function shutdown(signal: string): Promise<void> {
  console.log(`[bot] ${signal} received, shutting down gracefully...`)
  stopped = true
  if (pollTimer) clearTimeout(pollTimer)
  if (bookingSyncTimer) clearTimeout(bookingSyncTimer)
  if (calendarSyncTimer) clearTimeout(calendarSyncTimer)
  if (tgCommandTimer) clearTimeout(tgCommandTimer)
  await prisma.$disconnect().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)) })

// ─── Старт ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await initSentry('avito-bot')
  startHealthServer()
  console.log('[bot] AvitoBot started, polling every 30s')
  pollLoop()

  console.log(`[tgCmd] Telegram-кнопки активны, опрос каждые ${Math.round(TG_COMMAND_INTERVAL_MS / 1000)}s`)
  telegramCommandLoop()

  if (isBookingSyncConfigured()) {
    console.log(`[bookingSync] enabled, syncing every ${Math.round(BOOKING_SYNC_INTERVAL_MS / 1000)}s`)
    bookingSyncLoop()
  } else {
    console.log('[bookingSync] не настроен (AVITO_BOOKING_CLIENT_ID/SECRET/AVITO_USER_ID) — пропуск')
  }

  console.log(`[calendarSync] iCal-синхронизация каждые ${Math.round(CALENDAR_SYNC_INTERVAL_MS / 60_000)} мин`)
  calendarSyncLoop()
}

main().catch((err) => {
  console.error('[bot] startup error:', err)
  captureError(err, { component: 'avito-bot:startup' })
  process.exit(1)
})
