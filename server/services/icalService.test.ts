import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIcal, buildIcal, formatIcalDate } from './icalService.js'

const YANDEX_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Yandex Travel//RU',
  'BEGIN:VEVENT',
  'UID:ya-12345@travel.yandex.ru',
  'DTSTART;VALUE=DATE:20260815',
  'DTEND;VALUE=DATE:20260820',
  'SUMMARY:Забронировано',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

test('parseIcal: читает all-day VEVENT с DATE', () => {
  const events = parseIcal(YANDEX_FEED)
  assert.equal(events.length, 1)
  assert.equal(events[0].uid, 'ya-12345@travel.yandex.ru')
  assert.equal(events[0].summary, 'Забронировано')
  assert.equal(formatIcalDate(events[0].start), '20260815')
  assert.equal(formatIcalDate(events[0].end), '20260820')
})

// Реальный ответ public.extranet.travel.yandex.net (сверено с живым фидом 03.08.2026):
// порядок полей отличается от нашего, есть DESCRIPTION/CREATED/LAST-MODIFIED,
// которые мы игнорируем. Регрессия на случай доработок парсера.
test('parseIcal: реальный фид Яндекс Путешествий', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Yandex LLC//NONSGML Travel.Yandex//EN',
    'CALSCALE:GREGORIAN',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:5f71a544-9aad-4b23-82a8-ebef9c4ff6f2@yandex.com',
    'DTSTART;VALUE=DATE:20260808',
    'DTEND;VALUE=DATE:20260809',
    'SUMMARY:Бронирование на Яндекс Путешествиях',
    'DESCRIPTION:Категория номера: 498662',
    'CREATED:20260712T192348Z',
    'LAST-MODIFIED:20260712T192348Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  const events = parseIcal(feed)
  assert.equal(events.length, 1)
  assert.equal(events[0].uid, '5f71a544-9aad-4b23-82a8-ebef9c4ff6f2@yandex.com')
  assert.equal(events[0].summary, 'Бронирование на Яндекс Путешествиях')
  assert.equal(formatIcalDate(events[0].start), '20260808')
  assert.equal(formatIcalDate(events[0].end), '20260809')
})

test('parseIcal: читает DATE-TIME с Z', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:a@b',
    'DTSTART:20260901T140000Z',
    'DTEND:20260903T100000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const events = parseIcal(feed)
  assert.equal(events.length, 1)
  assert.equal(formatIcalDate(events[0].start), '20260901')
  assert.equal(formatIcalDate(events[0].end), '20260903')
})

test('parseIcal: разворачивает folded-строки', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:very-long-uid-that-was',
    ' -folded@example.com',
    'DTSTART;VALUE=DATE:20260101',
    'DTEND;VALUE=DATE:20260102',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const events = parseIcal(feed)
  assert.equal(events[0].uid, 'very-long-uid-that-was-folded@example.com')
})

test('parseIcal: пропускает битые события, но берёт валидные', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:broken',
    'SUMMARY:Без дат',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:ok',
    'DTSTART;VALUE=DATE:20260301',
    'DTEND;VALUE=DATE:20260305',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const events = parseIcal(feed)
  assert.equal(events.length, 1)
  assert.equal(events[0].uid, 'ok')
})

test('parseIcal: отбрасывает событие с end <= start', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:inverted',
    'DTSTART;VALUE=DATE:20260310',
    'DTEND;VALUE=DATE:20260305',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  assert.equal(parseIcal(feed).length, 0)
})

test('parseIcal: пустой календарь без событий', () => {
  assert.equal(parseIcal('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n').length, 0)
})

test('parseIcal: снимает экранирование в SUMMARY', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:esc',
    'DTSTART;VALUE=DATE:20260101',
    'DTEND;VALUE=DATE:20260102',
    'SUMMARY:Иванов\\, Пётр',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  assert.equal(parseIcal(feed)[0].summary, 'Иванов, Пётр')
})

test('buildIcal → parseIcal: round-trip сохраняет даты', () => {
  const ics = buildIcal('Квартира на Ленина', [
    {
      uid: 'booking-1@avitobot',
      summary: 'Занято (Авито)',
      start: new Date(Date.UTC(2026, 7, 15)),
      end: new Date(Date.UTC(2026, 7, 20)),
    },
  ])

  assert.ok(ics.startsWith('BEGIN:VCALENDAR'))
  assert.ok(ics.includes('X-WR-CALNAME:Квартира на Ленина'))
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'))

  const back = parseIcal(ics)
  assert.equal(back.length, 1)
  assert.equal(back[0].uid, 'booking-1@avitobot')
  assert.equal(formatIcalDate(back[0].start), '20260815')
  assert.equal(formatIcalDate(back[0].end), '20260820')
})

test('buildIcal: экранирует запятые в названии', () => {
  const ics = buildIcal('Тест', [
    {
      uid: 'u@a',
      summary: 'Занято (Яндекс), 2 гостя',
      start: new Date(Date.UTC(2026, 0, 1)),
      end: new Date(Date.UTC(2026, 0, 2)),
    },
  ])
  assert.ok(ics.includes('SUMMARY:Занято (Яндекс)\\, 2 гостя'))
  assert.equal(parseIcal(ics)[0].summary, 'Занято (Яндекс), 2 гостя')
})

test('buildIcal: строки не длиннее 75 октетов (folding)', () => {
  const ics = buildIcal('Тест', [
    {
      uid: 'x'.repeat(200) + '@avitobot',
      summary: 'A'.repeat(200),
      start: new Date(Date.UTC(2026, 0, 1)),
      end: new Date(Date.UTC(2026, 0, 2)),
    },
  ])
  for (const line of ics.split('\r\n')) {
    assert.ok(line.length <= 75, `строка длиннее 75: ${line.length}`)
  }
})
