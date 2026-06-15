import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAvitoBooking } from './avitoBookingService.js'

test('parseAvitoBooking: извлекает оплату из safe_deposit.total_amount', () => {
  const r = parseAvitoBooking({
    avito_booking_id: 12345,
    contact: { name: 'Иван Петров' },
    check_in: '2026-07-01T11:00:00Z',
    check_out: '2026-07-05T08:00:00Z',
    base_price: 20000,
    safe_deposit: { total_amount: 5000 },
  })
  assert.ok(r)
  assert.equal(r.avitoBookingId, '12345')
  assert.equal(r.guestName, 'Иван Петров')
  assert.equal(r.totalPrice, 20000)
  assert.equal(r.prepaidAmount, 5000)
  assert.equal(r.isCancelled, false)
})

test('parseAvitoBooking: предоплата 0 → неоплачено', () => {
  const r = parseAvitoBooking({
    avito_booking_id: 1,
    check_in: '2026-07-01T11:00:00Z',
    check_out: '2026-07-05T08:00:00Z',
    base_price: 20000,
  })
  assert.ok(r)
  assert.equal(r.prepaidAmount, 0)
})

test('parseAvitoBooking: статус canceled помечается isCancelled', () => {
  const r = parseAvitoBooking({ avito_booking_id: 2, status: 'canceled', check_in: 'x', check_out: 'y' })
  assert.ok(r)
  assert.equal(r.isCancelled, true)
})

test('parseAvitoBooking: без id возвращает null', () => {
  assert.equal(parseAvitoBooking({ contact: { name: 'X' } }), null)
})

test('parseAvitoBooking: имя по умолчанию когда contact пуст', () => {
  const r = parseAvitoBooking({ id: 7, check_in: 'a', check_out: 'b' })
  assert.ok(r)
  assert.equal(r.guestName, 'Авито гость')
})

test('parseAvitoBooking: поддерживает альтернативные имена полей', () => {
  const r = parseAvitoBooking({
    booking_id: 'B-9',
    user: { name: 'Анна' },
    date_from: '2026-08-01',
    date_to: '2026-08-03',
    price: 9000,
    prepaid_amount: 3000,
  })
  assert.ok(r)
  assert.equal(r.avitoBookingId, 'B-9')
  assert.equal(r.guestName, 'Анна')
  assert.equal(r.checkIn, '2026-08-01')
  assert.equal(r.totalPrice, 9000)
  assert.equal(r.prepaidAmount, 3000)
})
