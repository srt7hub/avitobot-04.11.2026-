import { useState, useEffect } from 'react'
import { fetchAvitoItems, fetchProperties, updateProperty, AvitoItem, Property } from '../api'

function statusLabel(status: string) {
  const map: Record<string, { label: string; color: string }> = {
    active: { label: 'Активно', color: 'text-emerald-600' },
    old: { label: 'Старое', color: 'text-yellow-600' },
    blocked: { label: 'Заблокировано', color: 'text-red-500' },
    rejected: { label: 'Отклонено', color: 'text-red-500' },
    removed: { label: 'Удалено', color: 'text-gray-400' },
    closed: { label: 'Закрыто', color: 'text-gray-400' },
  }
  return map[status] ?? { label: status, color: 'text-gray-500' }
}

function AvitoItemCard({ item }: { item: AvitoItem }) {
  const [imgIdx, setImgIdx] = useState(0)
  const images = (item.images ?? [])
    .map(img => img['640x480'] || img['208x156'] || img['1280x960'])
    .filter(Boolean) as string[]
  const status = statusLabel(item.status)

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {images.length > 0 ? (
        <div className="relative">
          <img src={images[imgIdx]} alt={item.title} className="w-full h-48 object-cover" />
          {images.length > 1 && (
            <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1">
              {images.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setImgIdx(i)}
                  className={`w-1.5 h-1.5 rounded-full transition-colors ${i === imgIdx ? 'bg-white' : 'bg-white/50'}`}
                />
              ))}
            </div>
          )}
          {images.length > 1 && (
            <>
              <button
                onClick={() => setImgIdx(n => Math.max(0, n - 1))}
                className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/50 text-white rounded-full w-7 h-7 flex items-center justify-center text-xs transition-colors"
              >‹</button>
              <button
                onClick={() => setImgIdx(n => Math.min(images.length - 1, n + 1))}
                className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/50 text-white rounded-full w-7 h-7 flex items-center justify-center text-xs transition-colors"
              >›</button>
            </>
          )}
        </div>
      ) : (
        <div className="w-full h-32 bg-gray-100 flex items-center justify-center">
          <span className="text-gray-400 text-xs">Нет фото</span>
        </div>
      )}
      <div className="p-4 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-gray-800 leading-tight">{item.title}</p>
          <span className={`text-xs font-medium flex-shrink-0 ${status.color}`}>● {status.label}</span>
        </div>
        {item.price !== null && (
          <p className="text-base font-bold text-gray-900">
            {item.price === 0 ? 'Цена не указана' : `${item.price.toLocaleString('ru-RU')} ₽`}
          </p>
        )}
        {item.address && <p className="text-xs text-gray-500">{item.address}</p>}
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-xs text-blue-600 hover:underline mt-1"
        >
          Открыть на Авито →
        </a>
      </div>
    </div>
  )
}

export default function Properties() {
  const [items, setItems] = useState<AvitoItem[]>([])
  const [properties, setProperties] = useState<Property[]>([])
  const [selectedPropertyId, setSelectedPropertyId] = useState('')
  const [checkinForm, setCheckinForm] = useState({ intercomCode: '', mapUrl: '', doorCode: '', wifiName: '', wifiPassword: '', checkInInstructions: '' })
  const [savingCheckin, setSavingCheckin] = useState(false)
  const [checkinSaved, setCheckinSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([fetchAvitoItems(), fetchProperties()])
      .then(([itemsResult, propertiesResult]) => {
        if (itemsResult) setItems(itemsResult.items)
        if (propertiesResult) {
          setProperties(propertiesResult)
          if (propertiesResult[0]) selectProperty(propertiesResult[0])
        }
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Не удалось загрузить объявления'))
      .finally(() => setLoading(false))
  }, [])

  function selectProperty(property: Property) {
    setSelectedPropertyId(property.id)
    setCheckinForm({
      intercomCode: property.intercomCode ?? '', mapUrl: property.mapUrl ?? '', doorCode: property.doorCode ?? '',
      wifiName: property.wifiName ?? '', wifiPassword: property.wifiPassword ?? '', checkInInstructions: property.checkInInstructions ?? '',
    })
    setCheckinSaved(false)
  }

  async function saveCheckin() {
    if (!selectedPropertyId) return
    setSavingCheckin(true)
    setCheckinSaved(false)
    try {
      const updated = await updateProperty(selectedPropertyId, checkinForm)
      if (updated) setProperties(items => items.map(item => item.id === updated.id ? updated : item))
      setCheckinSaved(true)
    } finally {
      setSavingCheckin(false)
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">Объявления</h2>

      {loading && (
        <div className="flex items-center justify-center h-40">
          <p className="text-sm text-gray-400">Загрузка...</p>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-100 rounded-xl p-4">
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center">
          <p className="text-sm text-gray-400">Объявлений не найдено.</p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <>
          <p className="text-xs text-gray-400">Найдено: {items.length}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {items.map(item => <AvitoItemCard key={item.id} item={item} />)}
          </div>
        </>
      )}

      {!loading && properties.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Инструкция по заселению</h3>
            <p className="text-xs text-gray-500 mt-1">За 4 часа до оплаченного заезда бот покажет в Telegram полный текст для гостя и запросит подтверждение отправки.</p>
          </div>
          {properties.length > 1 && (
            <select value={selectedPropertyId} onChange={e => {
              const property = properties.find(item => item.id === e.target.value)
              if (property) selectProperty(property)
            }} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm">
              {properties.map(property => <option key={property.id} value={property.id}>{property.name}</option>)}
            </select>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input value={checkinForm.intercomCode} onChange={e => setCheckinForm(f => ({ ...f, intercomCode: e.target.value }))} placeholder="Код домофона" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input value={checkinForm.doorCode} onChange={e => setCheckinForm(f => ({ ...f, doorCode: e.target.value }))} placeholder="Код доступа в квартиру" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input value={checkinForm.wifiName} onChange={e => setCheckinForm(f => ({ ...f, wifiName: e.target.value }))} placeholder="Название Wi-Fi" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <input value={checkinForm.wifiPassword} onChange={e => setCheckinForm(f => ({ ...f, wifiPassword: e.target.value }))} placeholder="Пароль Wi-Fi" className="border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          </div>
          <input value={checkinForm.mapUrl} onChange={e => setCheckinForm(f => ({ ...f, mapUrl: e.target.value }))} placeholder="Ссылка на 2ГИС или Яндекс Карты" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
          <textarea value={checkinForm.checkInInstructions} onChange={e => setCheckinForm(f => ({ ...f, checkInInstructions: e.target.value }))} rows={4} placeholder={'Необязательный свой шаблон. Плейсхолдеры: {{address}}, {{intercomCode}}, {{doorCode}}, {{mapUrl}}, {{wifiName}}, {{wifiPassword}}'} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-y" />
          <div className="flex items-center gap-3">
            <button onClick={saveCheckin} disabled={savingCheckin} className="bg-gray-900 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50">{savingCheckin ? 'Сохранение...' : 'Сохранить инструкцию'}</button>
            {checkinSaved && <span className="text-sm text-emerald-600">Сохранено</span>}
          </div>
        </section>
      )}
    </div>
  )
}
