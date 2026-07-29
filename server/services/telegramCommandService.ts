import prisma from '../prisma.js'
import { setBotDisabled, resumeDialogue } from './memoryService.js'
import {
  getUpdates,
  answerCallbackQuery,
  replaceKeyboardWithStatus,
  CB_BOT_ON,
  CB_BOT_OFF,
  type TelegramUpdate,
} from './telegramService.js'
import type { Tenant, TenantAvitoConfig } from '@prisma/client'

// Входящий канал Telegram: приём нажатий inline-кнопок под уведомлениями.
// Long-polling (getUpdates), а не webhook: у каждого тенанта СВОЙ бот-токен,
// webhook потребовал бы setWebhook на каждый токен + публичный HTTPS-эндпоинт.
// Опрос идёт без блокировки (timeout=0) — цикл крутится рядом с поллингом Авито.

// Права намеренно не персональные: управлять ботом может любой участник группы,
// в которую подключён бот тенанта. Единственная проверка — что апдейт пришёл
// именно из telegramChatId этого тенанта, а не из постороннего чата.
export function isAuthorizedChat(update: TelegramUpdate, tenantChatId: string): boolean {
  const fromChatId = update.callback_query?.message?.chat.id
  if (fromChatId === undefined) return false
  if (!tenantChatId?.trim()) return false
  return String(fromChatId) === String(tenantChatId).trim()
}

/**
 * Разбирает callback_data вида "<action>:<dialogueId>".
 * Возвращает null для неизвестных действий и пустых id — вызывающий код
 * не должен трогать БД по непроверенным данным.
 */
export function parseCallbackData(
  data: string | undefined
): { action: typeof CB_BOT_ON | typeof CB_BOT_OFF; dialogueId: string } | null {
  if (!data) return null
  const sep = data.indexOf(':')
  if (sep === -1) return null
  const action = data.slice(0, sep)
  const dialogueId = data.slice(sep + 1).trim()
  if (action !== CB_BOT_ON && action !== CB_BOT_OFF) return null
  if (!dialogueId) return null
  return { action, dialogueId }
}

export function actorName(update: TelegramUpdate): string {
  const from = update.callback_query?.from
  if (!from) return 'менеджер'
  return from.first_name || (from.username ? `@${from.username}` : 'менеджер')
}

function nowHHMM(): string {
  return new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: process.env.TZ || 'Europe/Moscow',
  })
}

async function handleCallback(
  config: TenantAvitoConfig & { tenant: Tenant },
  update: TelegramUpdate
): Promise<void> {
  const cb = update.callback_query
  if (!cb?.data) return

  const { tenantId, tenant } = config
  const botToken = tenant.telegramBotToken

  const parsed = parseCallbackData(cb.data)
  if (!parsed) {
    // 'noop' (строка статуса) и всё неизвестное — просто гасим спиннер.
    await answerCallbackQuery(botToken, cb.id)
    return
  }
  const { action, dialogueId } = parsed

  // Диалог обязан принадлежать этому тенанту: callback_data приходит извне и
  // может быть подделана, иначе тенант дотянулся бы до чужого диалога.
  const dialogue = await prisma.dialogue.findUnique({
    where: { id: dialogueId },
    select: { id: true, tenantId: true, guestName: true },
  })
  if (!dialogue || dialogue.tenantId !== tenantId) {
    await answerCallbackQuery(botToken, cb.id, 'Диалог не найден')
    return
  }

  const who = actorName(update)
  let status: string

  if (action === CB_BOT_ON) {
    // Снимаем оба состояния разом: и ручное отключение, и авто-паузу.
    await resumeDialogue(dialogue.id, tenantId)
    status = `✅ Бот включён · ${who} · ${nowHHMM()}`
    console.log(`[tgCmd][${tenantId}] Бот включён в диалоге ${dialogue.id} (${who})`)
  } else {
    await setBotDisabled(dialogue.id, tenantId, true)
    status = `🔇 Бот выключен · ${who} · ${nowHHMM()}`
    console.log(`[tgCmd][${tenantId}] Бот выключен в диалоге ${dialogue.id} (${who})`)
  }

  await answerCallbackQuery(botToken, cb.id, status)

  // Заменяем кнопки строкой статуса: в группе видно, кто переключил, и кнопка
  // не жмётся повторно. Управление остаётся доступным на следующем уведомлении.
  const messageId = cb.message?.message_id
  if (messageId !== undefined && tenant.telegramChatId) {
    await replaceKeyboardWithStatus(botToken, tenant.telegramChatId, messageId, status)
  }
}

async function pollTenantUpdates(
  config: TenantAvitoConfig & { tenant: Tenant }
): Promise<void> {
  const { tenant, tenantId } = config
  if (!tenant.telegramBotToken || !tenant.telegramChatId) return

  const updates = await getUpdates(tenant.telegramBotToken, config.tgUpdateOffset)
  if (updates.length === 0) return

  let maxUpdateId = config.tgUpdateOffset
  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id)
    try {
      if (!update.callback_query) continue
      if (!isAuthorizedChat(update, tenant.telegramChatId)) {
        console.warn(`[tgCmd][${tenantId}] Апдейт из постороннего чата — игнорируем`)
        continue
      }
      await handleCallback(config, update)
    } catch (err) {
      console.error(`[tgCmd][${tenantId}] Ошибка обработки апдейта ${update.update_id}:`, err)
    }
  }

  // Сдвигаем offset за последний обработанный апдейт. Сохраняем в БД, чтобы
  // рестарт бота не переиграл уже обработанные нажатия. Двигаем даже при
  // ошибке обработки — иначе битый апдейт заблокирует очередь навсегда.
  const nextOffset = maxUpdateId + 1
  if (nextOffset !== config.tgUpdateOffset) {
    config.tgUpdateOffset = nextOffset
    await prisma.tenantAvitoConfig.update({
      where: { tenantId },
      data: { tgUpdateOffset: nextOffset },
    })
  }
}

export async function pollTelegramCommands(): Promise<void> {
  try {
    const configs = await prisma.tenantAvitoConfig.findMany({
      where: { tenant: { status: 'ACTIVE' } },
      include: { tenant: true },
    })
    const withTelegram = configs.filter(c => c.tenant.telegramBotToken && c.tenant.telegramChatId)
    if (withTelegram.length === 0) return

    await Promise.allSettled(withTelegram.map(c => pollTenantUpdates(c)))
  } catch (err) {
    console.error('[tgCmd] pollTelegramCommands error:', err)
  }
}
