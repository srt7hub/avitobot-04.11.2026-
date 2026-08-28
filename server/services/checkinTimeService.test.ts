import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractCheckinTime } from './checkinTimeService.js'

test('извлекает время из ясной фразы о заселении', () => {
  assert.deepEqual(extractCheckinTime('Заселимся в 22'), { minutes: 1320, label: '22:00' })
  assert.deepEqual(extractCheckinTime('Подъедем к 19:30'), { minutes: 1170, label: '19:30' })
  assert.deepEqual(extractCheckinTime('Будем у вас после 18 часов'), { minutes: 1080, label: '18:00' })
})

test('не путает время заезда с другими сообщениями', () => {
  assert.equal(extractCheckinTime('Позвоните мне в 22'), null)
  assert.equal(extractCheckinTime('Выедем в 22'), null)
  assert.equal(extractCheckinTime('Заселимся вечером'), null)
  assert.equal(extractCheckinTime('Заедем в 25'), null)
})
