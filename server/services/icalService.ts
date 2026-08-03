// iCal (RFC 5545) — минимальный парсер и генератор для синхронизации занятости.
//
// Почему свой, а не библиотека: нам нужны ровно VEVENT с DTSTART/DTEND/UID/SUMMARY
// из фидов площадок (Яндекс Путешествия, Авито, Циан). Это подмножество в десятки
// строк, тогда как полноценные ical-парсеры тянут таймзонную базу и рекуррентность,
// которых в фидах бронирования не бывает.
//
// Ограничение протокола: iCal передаёт ТОЛЬКО занятые даты. Цены и данные гостя
// в нём не ходят — синхронизация цен Авито→Яндекс через этот канал невозможна.

export interface IcalEvent {
  uid: string
  summary: string
  /** Включительно — день заезда. */
  start: Date
  /** Исключительно — день выезда свободен (семантика DTEND в iCal). */
  end: Date
}

/** Разворачивает folded-строки: продолжение начинается с пробела или таба (RFC 5545 §3.1). */
function unfold(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out
}

/**
 * Парсит значение даты iCal.
 * Поддерживает DATE (20260815) и DATE-TIME (20260815T140000Z / без Z).
 * Всё приводим к UTC-полуночи для DATE, чтобы сравнение дат не плясало от таймзоны сервера.
 */
function parseIcalDate(value: string): Date | null {
  const v = value.trim()

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v)
  if (dateTime) {
    const [, y, m, d, hh, mm, ss] = dateTime
    // Локальное время фида без Z трактуем как UTC: для суточной занятости
    // сдвиг в пределах суток не меняет набор занятых дней.
    return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)))
  }

  return null
}

/** Экранирование текста для TEXT-полей (RFC 5545 §3.3.11). */
function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

/**
 * Извлекает VEVENT'ы из .ics.
 * Битые события пропускаются молча — один сломанный VEVENT в чужом фиде
 * не должен ронять синхронизацию всего календаря.
 */
export function parseIcal(raw: string): IcalEvent[] {
  const lines = unfold(raw)
  const events: IcalEvent[] = []

  let cur: Partial<IcalEvent> | null = null

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === 'BEGIN:VEVENT') {
      cur = {}
      continue
    }

    if (trimmed === 'END:VEVENT') {
      if (cur?.start && cur.end && cur.end > cur.start) {
        events.push({
          uid: cur.uid ?? '',
          summary: cur.summary ?? '',
          start: cur.start,
          end: cur.end,
        })
      }
      cur = null
      continue
    }

    if (!cur) continue

    const colon = trimmed.indexOf(':')
    if (colon === -1) continue

    const rawName = trimmed.slice(0, colon)
    const value = trimmed.slice(colon + 1)
    const name = rawName.split(';')[0].toUpperCase()

    switch (name) {
      case 'UID':
        cur.uid = value.trim()
        break
      case 'SUMMARY':
        cur.summary = unescapeText(value).trim()
        break
      case 'DTSTART': {
        const d = parseIcalDate(value)
        if (d) cur.start = d
        break
      }
      case 'DTEND': {
        const d = parseIcalDate(value)
        if (d) cur.end = d
        break
      }
    }
  }

  return events
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Формат DATE (YYYYMMDD) в UTC — для all-day событий занятости. */
export function formatIcalDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}

/** Формат DATE-TIME в UTC — для DTSTAMP. */
function formatIcalDateTime(d: Date): string {
  return `${formatIcalDate(d)}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

/** Складывает строку до 75 октетов (RFC 5545 §3.1) — иначе строгие парсеры площадок ругаются. */
function fold(line: string): string {
  if (line.length <= 75) return line
  const parts: string[] = [line.slice(0, 75)]
  let rest = line.slice(75)
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74))
    rest = rest.slice(74)
  }
  if (rest.length) parts.push(' ' + rest)
  return parts.join('\r\n')
}

export interface IcalExportEvent {
  uid: string
  summary: string
  start: Date
  /** Исключительно — день выезда остаётся свободным. */
  end: Date
}

/**
 * Собирает .ics для отдачи площадкам.
 * Пишем all-day события (VALUE=DATE): для посуточной аренды важен день, а не час,
 * и такой фид одинаково корректно читают Яндекс, Авито и Циан.
 */
export function buildIcal(calendarName: string, events: IcalExportEvent[], now: Date = new Date()): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AvitoBot//Calendar Sync//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${escapeText(calendarName)}`),
  ]

  const stamp = formatIcalDateTime(now)

  for (const ev of events) {
    lines.push(
      'BEGIN:VEVENT',
      fold(`UID:${ev.uid}`),
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${formatIcalDate(ev.start)}`,
      `DTEND;VALUE=DATE:${formatIcalDate(ev.end)}`,
      fold(`SUMMARY:${escapeText(ev.summary)}`),
      'TRANSP:OPAQUE',
      'STATUS:CONFIRMED',
      'END:VEVENT',
    )
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}
