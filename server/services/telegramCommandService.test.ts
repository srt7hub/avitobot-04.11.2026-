import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAuthorizedChat,
  parseCallbackData,
  actorName,
} from './telegramCommandService.js'
import { CB_BOT_ON, CB_BOT_OFF, type TelegramUpdate } from './telegramService.js'

function update(partial: {
  chatId?: number
  data?: string
  from?: { id: number; first_name?: string; username?: string }
}): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: 'cb1',
      ...(partial.from && { from: partial.from }),
      ...(partial.chatId !== undefined && {
        message: { message_id: 10, chat: { id: partial.chatId } },
      }),
      ...(partial.data !== undefined && { data: partial.data }),
    },
  }
}

// ─── Авторизация: по чату, не по пользователю ────────────────────────────────
// Управлять ботом может любой участник группы — намеренное решение.

test('апдейт из чата тенанта авторизован', () => {
  assert.equal(isAuthorizedChat(update({ chatId: -100123 }), '-100123'), true)
})

test('апдейт из постороннего чата отклоняется', () => {
  assert.equal(isAuthorizedChat(update({ chatId: -999 }), '-100123'), false)
})

test('chatId тенанта с пробелами всё равно матчится', () => {
  assert.equal(isAuthorizedChat(update({ chatId: -100123 }), '  -100123  '), true)
})

test('апдейт без message не авторизован', () => {
  assert.equal(isAuthorizedChat(update({}), '-100123'), false)
})

test('пустой telegramChatId тенанта не авторизует никого', () => {
  assert.equal(isAuthorizedChat(update({ chatId: -100123 }), ''), false)
})

// ─── Разбор callback_data ────────────────────────────────────────────────────

test('разбирает включение бота', () => {
  assert.deepEqual(parseCallbackData(`${CB_BOT_ON}:abc123`), {
    action: CB_BOT_ON,
    targetId: 'abc123',
  })
})

test('разбирает выключение бота', () => {
  assert.deepEqual(parseCallbackData(`${CB_BOT_OFF}:abc123`), {
    action: CB_BOT_OFF,
    targetId: 'abc123',
  })
})

test('noop (строка статуса) не распознаётся как действие', () => {
  assert.equal(parseCallbackData('noop'), null)
})

test('неизвестное действие отклоняется', () => {
  assert.equal(parseCallbackData('drop:abc123'), null)
})

test('пустой dialogueId отклоняется', () => {
  assert.equal(parseCallbackData(`${CB_BOT_ON}:`), null)
})

test('undefined data отклоняется', () => {
  assert.equal(parseCallbackData(undefined), null)
})

// ─── Имя нажавшего (для строки статуса, не для прав) ─────────────────────────

test('берёт first_name', () => {
  assert.equal(actorName(update({ from: { id: 1, first_name: 'Иван' } })), 'Иван')
})

test('падает на username, если нет имени', () => {
  assert.equal(actorName(update({ from: { id: 1, username: 'ivan' } })), '@ivan')
})

test('без данных о пользователе — обобщённое «менеджер»', () => {
  assert.equal(actorName(update({ chatId: -1 })), 'менеджер')
})
