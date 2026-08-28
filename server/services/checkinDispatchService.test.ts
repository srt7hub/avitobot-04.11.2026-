import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkinMoment } from './checkinDispatchService.js'

test('checkinMoment: переводит 14:00 Уфа (UTC+5) в 09:00 UTC', () => {
  const previousTime = process.env.CHECKIN_DEFAULT_TIME
  const previousOffset = process.env.CHECKIN_UTC_OFFSET_HOURS
  process.env.CHECKIN_DEFAULT_TIME = '14:00'
  process.env.CHECKIN_UTC_OFFSET_HOURS = '5'

  const result = checkinMoment(new Date('2026-08-28T00:00:00.000Z'))
  assert.equal(result.toISOString(), '2026-08-28T09:00:00.000Z')

  if (previousTime === undefined) delete process.env.CHECKIN_DEFAULT_TIME
  else process.env.CHECKIN_DEFAULT_TIME = previousTime
  if (previousOffset === undefined) delete process.env.CHECKIN_UTC_OFFSET_HOURS
  else process.env.CHECKIN_UTC_OFFSET_HOURS = previousOffset
})
