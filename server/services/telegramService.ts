import prisma from '../prisma.js'

const TG_API =process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'

// ─── Inline-кнопки управления ботом ──────────────────────────────────────────
// callback_data ограничена 64 байтами, поэтому шлём dialogue.id (cuid, ~25 симв.),
// а не avitoChatId. Формат: "<action>:<dialogueId>".
export const CB_BOT_OFF = 'boff'
export const CB_BOT_ON = 'bon'
export const CB_CHECKIN_SEND = 'cis'
export const CB_CHECKIN_DELAY = 'cid'
export const CB_CHECKIN_CANCEL = 'cic'

type InlineButton = { text: string; callback_data?: string; url?: string }
type InlineKeyboard = { inline_keyboard: InlineButton[][] }

function avitoChatUrl(avitoChatId: string): string {
  return `https://www.avito.ru/profile/messenger/channel/${avitoChatId}`
}

/**
 * Клавиатура управления ботом под уведомлением.
 * botSilent — бот сейчас молчит в этом чате (botDisabled ИЛИ активная пауза):
 * тогда показываем «Включить», иначе «Выключить». Одна кнопка, одно состояние —
 * менеджеру не нужно знать, чем именно бот остановлен.
 * dialogueId может отсутствовать (диалог ещё не создан) — тогда только ссылка.
 */
function botControlKeyboard(
  avitoChatId: string,
  dialogueId: string | null,
  botSilent: boolean
): InlineKeyboard {
  const row: InlineButton[] = []
  if (dialogueId) {
    row.push(
      botSilent
        ? { text: '▶️ Включить бота', callback_data: `${CB_BOT_ON}:${dialogueId}` }
        : { text: '🔇 Выключить бота', callback_data: `${CB_BOT_OFF}:${dialogueId}` }
    )
  }
  row.push({ text: 'Открыть диалог', url: avitoChatUrl(avitoChatId) })
  return { inline_keyboard: [row] }
}

type SendMessageResponse = {
  ok: boolean
  result?: { message_id?: number }
  parameters?: { migrate_to_chat_id?: number }
}

// Группа стала супергруппой (клиент поменял настройки чата) — у неё новый chat_id.
// Переписываем его у всех тенантов с этой парой токен+чат, иначе уведомления молча пропадают.
async function migrateChatId(botToken: string, oldChatId: string, newChatId: string): Promise<void> {
  const { count } = await prisma.tenant.updateMany({
    where: { telegramBotToken: botToken, telegramChatId: oldChatId },
    data: { telegramChatId: newChatId },
  })
  console.warn(`[telegramService] chat ${oldChatId} migrated to supergroup ${newChatId}, tenants updated: ${count}`)
}

async function postMessage(
  botToken: string,
  chatId: string,
  text: string,
  replyMarkup?: InlineKeyboard,
  isRetry = false
): Promise<number | null> {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...(replyMarkup && { reply_markup: replyMarkup }),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = await res.text()
    const data = JSON.parse(body) as SendMessageResponse
    if (data.ok) return data.result?.message_id ?? null

    console.error('[telegramService] sendMessage failed:', res.status, body)
    const migrateTo = data.parameters?.migrate_to_chat_id
    if (migrateTo && !isRetry) {
      await migrateChatId(botToken, chatId, String(migrateTo))
      return postMessage(botToken, String(migrateTo), text, replyMarkup, true)
    }
  } catch (err) {
    console.error('[telegramService] sendMessage error:', err)
  }
  return null
}

// Убирает спиннер на кнопке у нажавшего. Без этого Telegram крутит его ~30 сек.
export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string
): Promise<void> {
  try {
    await fetch(`${TG_API}/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text && { text }) }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('[telegramService] answerCallbackQuery error:', err)
  }
}

/**
 * Заменяет клавиатуру под уже отправленным сообщением на строку статуса —
 * так в группе видно, кто и когда переключил бота, и кнопка не жмётся повторно.
 */
export async function replaceKeyboardWithStatus(
  botToken: string,
  chatId: string,
  messageId: number,
  statusText: string
): Promise<void> {
  try {
    await fetch(`${TG_API}/bot${botToken}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: statusText, callback_data: 'noop' }]] },
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('[telegramService] editMessageReplyMarkup error:', err)
  }
}

// Забирает апдейты бота тенанта. Long-polling с коротким timeout: цикл крутится
// рядом с основным поллингом Авито, поэтому долго блокироваться здесь нельзя.
export async function getUpdates(
  botToken: string,
  offset: number,
  timeoutSec = 0
): Promise<TelegramUpdate[]> {
  try {
    const res = await fetch(`${TG_API}/bot${botToken}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: timeoutSec,
        allowed_updates: ['callback_query'],
      }),
      signal: AbortSignal.timeout((timeoutSec + 10) * 1000),
    })
    if (!res.ok) {
      console.error('[telegramService] getUpdates failed:', res.status, await res.text())
      return []
    }
    const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] }
    return data.ok && data.result ? data.result : []
  } catch (err) {
    console.error('[telegramService] getUpdates error:', err)
    return []
  }
}

export type TelegramUpdate = {
  update_id: number
  callback_query?: {
    id: string
    from?: { id: number; first_name?: string; username?: string }
    message?: { message_id: number; chat: { id: number } }
    data?: string
  }
}

export async function sendHumanTakeoverAlert(
  botToken: string,
  chatId: string,
  avitoChatId: string,
  guestName: string,
  dialogueId: string | null = null
): Promise<void> {
  if (!botToken || !chatId) return

  const text = [
    `🚨 <b>ЗАПРОС ОПЕРАТОРА</b>`,
    ``,
    `Гость: <b>${guestName}</b>`,
    ``,
    `Гость просит связаться с менеджером.`,
    `Бот на паузе 30 мин.`,
  ].join('\n')

  // Бот только что встал на авто-паузу → предлагаем «Включить».
  await postMessage(botToken, chatId, text, botControlKeyboard(avitoChatId, dialogueId, true))
}

export async function sendDialogueNotification(
  botToken: string,
  chatId: string,
  avitoChatId: string,
  guestName: string,
  guestMessage: string,
  aiReply: string,
  dialogueId: string | null = null
): Promise<void> {
  if (!botToken || !chatId) return

  const text = [
    `💬 <b>${guestName}</b>`,
    `${guestMessage.slice(0, 300)}`,
    ``,
    `🤖 <b>AI:</b>`,
    `${aiReply.slice(0, 300)}`,
  ].join('\n')

  // Бот ответил → он активен → кнопка «Выключить».
  await postMessage(botToken, chatId, text, botControlKeyboard(avitoChatId, dialogueId, false))
}

// Гость написал, пока чат на паузе (бот молчит — ждёт оператора). Дублируем
// сообщение менеджеру, чтобы он видел переписку и мог ответить сам.
export async function sendPausedMessageNotification(
  botToken: string,
  chatId: string,
  avitoChatId: string,
  guestName: string,
  guestMessage: string,
  dialogueId: string | null = null
): Promise<void> {
  if (!botToken || !chatId) return

  const text = [
    `⏸️ <b>Бот молчит — нужен ответ менеджера</b>`,
    ``,
    `Гость: <b>${guestName}</b>`,
    `${guestMessage.slice(0, 300)}`,
  ].join('\n')

  // Бот молчит → кнопка «Включить».
  await postMessage(botToken, chatId, text, botControlKeyboard(avitoChatId, dialogueId, true))
}

export async function sendUnknownAnswerAlert(
  botToken: string,
  chatId: string,
  avitoChatId: string,
  guestName: string,
  guestMessage: string,
  aiReply: string,
  dialogueId: string | null = null,
  botSilent = true
): Promise<void> {
  if (!botToken || !chatId) return

  const text = [
    `⚠️ <b>Бот не знает ответ</b>`,
    ``,
    `Гость: <b>${guestName}</b>`,
    `${guestMessage.slice(0, 300)}`,
    ``,
    `🤖 <b>AI ответил:</b>`,
    `${aiReply.slice(0, 300)}`,
  ].join('\n')

  await postMessage(botToken, chatId, text, botControlKeyboard(avitoChatId, dialogueId, botSilent))
}

export async function sendOpsAlert(message: string): Promise<void> {
  const botToken = process.env.OPS_TELEGRAM_BOT_TOKEN
  const chatId = process.env.OPS_TELEGRAM_CHAT_ID

  if (!botToken || !chatId) return

  await postMessage(botToken, chatId, `[OPS ALERT] ${message}`)
}

/** Карточка для менеджера. Секреты намеренно не дублируются в Telegram-группе. */
export async function sendCheckinApprovalRequest(
  botToken: string,
  chatId: string,
  dispatchId: string,
  booking: { guestName: string; propertyName: string; address: string; checkInLabel: string; instruction: string },
): Promise<void> {
  if (!botToken || !chatId) return

  const text = [
    '<b>ЗАСЕЛЕНИЕ ГОТОВО К ОТПРАВКЕ</b>',
    '',
    `Гость: <b>${booking.guestName || 'Авито гость'}</b>`,
    `Квартира: <b>${booking.propertyName}</b>`,
    booking.address ? `Адрес: ${booking.address}` : '',
    `Заезд: ${booking.checkInLabel}`,
    '',
    '<b>Текст, который уйдёт гостю:</b>',
    `<pre>${escapeHtml(booking.instruction)}</pre>`,
  ].filter(Boolean).join('\n')

  const keyboard: InlineKeyboard = {
    inline_keyboard: [[
      { text: 'Отправить инструкцию', callback_data: `${CB_CHECKIN_SEND}:${dispatchId}` },
      { text: 'Отложить 30 мин', callback_data: `${CB_CHECKIN_DELAY}:${dispatchId}` },
    ], [
      { text: 'Не отправлять', callback_data: `${CB_CHECKIN_CANCEL}:${dispatchId}` },
    ]],
  }
  await postMessage(botToken, chatId, text, keyboard)
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
