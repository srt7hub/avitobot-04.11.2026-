import { useState, useEffect } from 'react'
import {
  fetchCalendar,
  syncCalendars,
  addCalendarSync,
  deleteCalendarSync,
  createCalendarFeed,
  CalendarData,
  CalendarProperty,
  CalendarInterval,
} from '../api'

const PLATFORMS = ['ЯНДЕКС', 'АВИТО', 'ЦИАН', 'ДРУГОЕ']

// Цвет полоски по площадке — чтобы источник брони читался с одного взгляда.
const PLATFORM_COLOR: Record<string, string> = {
  'Авито': 'bg-emerald-500',
  'АВИТО': 'bg-emerald-500',
  'ЯНДЕКС': 'bg-red-500',
  'ЦИАН': 'bg-blue-500',
  'ДРУГОЕ': 'bg-gray-400',
}

function colorFor(platform: string): string {
  return PLATFORM_COLOR[platform] ?? PLATFORM_COLOR[platform.toUpperCase()] ?? 'bg-gray-400'
}

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

/** Полночь UTC — календарь считаем в UTC, чтобы день не сползал от таймзоны. */
function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

const DAY_MS = 24 * 60 * 60 * 1000

function daysInMonth(year: number, month: number): Date[] {
  const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, month, i + 1)))
}

function isWeekend(d: Date): boolean {
  const wd = d.getUTCDay()
  return wd === 0 || wd === 6
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function fmtSyncTime(iso: string | null): string {
  if (!iso) return 'ещё не синхронизировался'
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'только что'
  if (mins < 60) return `${mins} мин назад`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} ч назад`
  return `${Math.round(hours / 24)} дн назад`
}

/**
 * Копирование с фолбэком: navigator.clipboard существует только в secure context
 * (https или localhost). Панель открывают и по http на IP — там обращение к
 * .writeText падает, поэтому пробуем execCommand и в крайнем случае молча сдаёмся:
 * ссылка всё равно видна в поле и её можно выделить руками.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // ниже — запасной путь
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function Calendar() {
  const [data, setData] = useState<CalendarData | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const now = new Date()
  const [year, setYear] = useState(now.getUTCFullYear())
  const [month, setMonth] = useState(now.getUTCMonth())

  const [settingsFor, setSettingsFor] = useState<string | null>(null)

  const days = daysInMonth(year, month)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const from = new Date(Date.UTC(year, month, 1)).toISOString()
      const to = new Date(Date.UTC(year, month + 1, 0)).toISOString()
      const res = await fetchCalendar(from, to)
      if (res) setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить календарь')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month])

  async function handleSync() {
    setSyncing(true)
    setNotice('')
    setError('')
    try {
      const res = await syncCalendars()
      if (res) {
        setNotice(
          res.failed > 0
            ? `Обновлено каналов: ${res.synced}, с ошибкой: ${res.failed}`
            : `Синхронизация выполнена (каналов: ${res.synced})`
        )
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации')
    } finally {
      setSyncing(false)
    }
  }

  function shiftMonth(delta: number) {
    const d = new Date(Date.UTC(year, month + delta, 1))
    setYear(d.getUTCFullYear())
    setMonth(d.getUTCMonth())
  }

  if (loading && !data) {
    return <div className="flex items-center justify-center h-40"><p className="text-sm text-gray-400">Загрузка…</p></div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Календарь</h2>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors"
        >
          {syncing ? 'Обновляем…' : 'Обновить сейчас'}
        </button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {notice && <p className="text-sm text-emerald-600">{notice}</p>}

      {/* Переключатель месяца */}
      <div className="flex items-center justify-between bg-white rounded-xl border border-gray-100 px-4 py-2.5">
        <button onClick={() => shiftMonth(-1)} className="px-2 py-1 text-sm text-gray-500 hover:text-gray-900 rounded-lg hover:bg-gray-50">
          ← Назад
        </button>
        <span className="text-sm font-medium text-gray-900">{MONTHS[month]} {year}</span>
        <button onClick={() => shiftMonth(1)} className="px-2 py-1 text-sm text-gray-500 hover:text-gray-900 rounded-lg hover:bg-gray-50">
          Вперёд →
        </button>
      </div>

      {!data?.properties.length && (
        <div className="bg-white rounded-xl border border-gray-100 p-6 text-center">
          <p className="text-sm text-gray-500">Объектов пока нет.</p>
          <p className="text-xs text-gray-400 mt-1">Добавьте объект во вкладке «Объявления».</p>
        </div>
      )}

      {/* Сетка: объекты × дни */}
      {data?.properties.map(p => (
        <PropertyRow
          key={p.propertyId}
          property={p}
          days={days}
          open={settingsFor === p.propertyId}
          onToggle={() => setSettingsFor(settingsFor === p.propertyId ? null : p.propertyId)}
          onChanged={load}
        />
      ))}

      {/* Легенда */}
      {!!data?.properties.length && (
        <div className="flex items-center gap-4 text-xs text-gray-500 px-1">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-emerald-500" />Авито</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-500" />Яндекс</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-blue-500" />Циан</span>
        </div>
      )}
    </div>
  )
}

function PropertyRow({
  property,
  days,
  open,
  onToggle,
  onChanged,
}: {
  property: CalendarProperty
  days: Date[]
  open: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  // День занят, если попадает в [start, end) хотя бы одного интервала:
  // день выезда свободен — в него можно заселять следующего гостя.
  function intervalFor(day: Date): CalendarInterval | undefined {
    const t = utcDay(day)
    return property.intervals.find(iv => {
      const s = utcDay(new Date(iv.start))
      const e = utcDay(new Date(iv.end))
      return t >= s && t < e
    })
  }

  const todayT = utcDay(new Date())

  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-50">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{property.name}</p>
          {property.address && <p className="text-xs text-gray-400 truncate">{property.address}</p>}
        </div>
        <button
          onClick={onToggle}
          className="shrink-0 ml-3 px-2.5 py-1 text-xs rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-50 transition-colors"
        >
          {open ? 'Скрыть' : 'Синхронизация'}
          {property.syncs.length > 0 && (
            <span className="ml-1.5 text-emerald-600">{property.syncs.length}</span>
          )}
        </button>
      </div>

      {/* Полоса дней */}
      <div className="overflow-x-auto">
        <div className="flex min-w-max px-4 py-3 gap-px">
          {days.map(day => {
            const iv = intervalFor(day)
            const t = utcDay(day)
            const isToday = t === todayT
            return (
              <div key={day.toISOString()} className="flex flex-col items-center gap-1 w-7 shrink-0">
                <span className={`text-[10px] leading-none ${isWeekend(day) ? 'text-red-400' : 'text-gray-400'}`}>
                  {day.getUTCDate()}
                </span>
                <div
                  title={
                    iv
                      ? `${iv.platform}: ${fmtDate(iv.start)} — ${fmtDate(iv.end)}${iv.guestName ? `, ${iv.guestName}` : ''}`
                      : 'Свободно'
                  }
                  className={`w-6 h-7 rounded ${
                    iv ? colorFor(iv.platform) : 'bg-gray-100'
                  } ${isToday ? 'ring-2 ring-gray-900 ring-offset-1' : ''}`}
                />
              </div>
            )
          })}
        </div>
      </div>

      {open && <SyncSettings property={property} onChanged={onChanged} />}
    </div>
  )
}

function SyncSettings({ property, onChanged }: { property: CalendarProperty; onChanged: () => void }) {
  const [platform, setPlatform] = useState('ЯНДЕКС')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [feedUrl, setFeedUrl] = useState('')
  const [copied, setCopied] = useState(false)

  async function handleAdd() {
    if (!url.trim()) {
      setErr('Вставьте ссылку на календарь')
      return
    }
    setBusy(true)
    setErr('')
    try {
      await addCalendarSync(property.propertyId, platform, url.trim())
      setUrl('')
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось подключить')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    setBusy(true)
    try {
      await deleteCalendarSync(id)
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось отключить')
    } finally {
      setBusy(false)
    }
  }

  async function handleFeed() {
    setBusy(true)
    setErr('')
    try {
      const res = await createCalendarFeed(property.propertyId)
      if (res) {
        const absolute = res.url.startsWith('http') ? res.url : `${window.location.origin}${res.url}`
        setFeedUrl(absolute)
        if (await copyToClipboard(absolute)) {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }
        onChanged()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось создать ссылку')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-gray-100 px-4 py-3 space-y-3 bg-gray-50/50">
      {/* Наша ссылка — её вставляют в экстранет площадки */}
      <div>
        <p className="text-xs font-medium text-gray-700 mb-1.5">Наш календарь для площадок</p>
        <div className="flex gap-2">
          <input
            readOnly
            value={feedUrl}
            placeholder="Нажмите «Получить ссылку»"
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg text-gray-600"
          />
          <button
            onClick={handleFeed}
            disabled={busy}
            className="shrink-0 px-2.5 py-1.5 text-xs rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {copied ? 'Скопировано' : feedUrl ? 'Обновить' : 'Получить ссылку'}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-1">
          Вставьте её в Яндекс Путешествия → Экстранет → Синхронизация календарей.
        </p>
        {/* Ссылку собирает сервер из APP_URL. Если он указывает на другой хост,
            площадка получит недоступный адрес — предупреждаем до похода в экстранет. */}
        {feedUrl && !feedUrl.startsWith(window.location.origin) && (
          <p className="text-[11px] text-amber-600 mt-1">
            Ссылка ведёт на другой адрес, чем открыта панель. Если площадка пишет «календарь
            недоступен» — проверьте, что домен из ссылки указывает на этот сервер.
          </p>
        )}
      </div>

      {/* Подключённые чужие календари */}
      {property.syncs.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-gray-700">Подключённые календари</p>
          {property.syncs.map(s => (
            <div key={s.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-2.5 py-1.5">
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-800">
                  {s.platform}
                  {s.lastSyncStatus === 'ОШИБКА' && <span className="ml-1.5 text-red-500">ошибка</span>}
                  {s.lastSyncStatus === 'ОК' && (
                    <span className="ml-1.5 text-emerald-600">
                      {s.lastEventCount} {plural(s.lastEventCount, 'бронь', 'брони', 'броней')}
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-gray-400 truncate">
                  {s.lastSyncStatus === 'ОШИБКА' ? s.lastSyncError : fmtSyncTime(s.lastSyncAt)}
                </p>
              </div>
              <button
                onClick={() => handleDelete(s.id)}
                disabled={busy}
                className="shrink-0 ml-2 text-xs text-gray-400 hover:text-red-500 disabled:opacity-50"
              >
                Отключить
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Добавить чужой календарь */}
      <div>
        <p className="text-xs font-medium text-gray-700 mb-1.5">Добавить календарь площадки</p>
        <div className="flex gap-2">
          <select
            value={platform}
            onChange={e => setPlatform(e.target.value)}
            className="shrink-0 px-2 py-1.5 text-xs bg-white border border-gray-200 rounded-lg text-gray-700"
          >
            {PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <input
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder="https://…/calendar.ics"
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-lg"
          />
          <button
            onClick={handleAdd}
            disabled={busy}
            className="shrink-0 px-2.5 py-1.5 text-xs rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
          >
            Добавить
          </button>
        </div>
      </div>

      {err && <p className="text-xs text-red-500">{err}</p>}

      <p className="text-[11px] text-gray-400 leading-relaxed">
        Площадки обновляют календари примерно раз в час — брони переносятся не мгновенно.
        Цены через iCal не передаются, их нужно менять на каждой площадке отдельно.
      </p>
    </div>
  )
}
