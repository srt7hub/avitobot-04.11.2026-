import { useState, useEffect } from 'react'
import { fetchDashboard, botStart, botStop, DashboardData } from '../api'
import BotStatus from './components/BotStatus'
import StatCard from './components/StatCard'
import DialogueList from './components/DialogueList'

interface Props {
  onNavigate: (page: string) => void
}

export default function Dashboard({ onNavigate }: Props) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [botLoading, setBotLoading] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const result = await fetchDashboard()
      if (result) setData(result)
    } catch {
      setError('Не удалось загрузить данные')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleBotToggle(start: boolean) {
    setBotLoading(true)
    try {
      if (start) await botStart()
      else await botStop()
      await load()
    } catch {
      setError('Не удалось изменить статус бота')
    } finally {
      setBotLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-sm text-gray-400">Загрузка...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-40">
        <p className="text-sm text-red-500">{error}</p>
      </div>
    )
  }

  if (!data) return null

  const autoReplyPct = Math.round(data.stats.autoReplyRate * 100)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900">Дашборд</h2>

      <BotStatus
        isRunning={data.bot.isRunning}
        loading={botLoading}
        onStart={() => handleBotToggle(true)}
        onStop={() => handleBotToggle(false)}
      />

      <div className="flex gap-3">
        <StatCard label="Сегодня" value={data.stats.today} />
        <StatCard label="Неделя" value={data.stats.week} />
        <StatCard label="30 дней" value={data.stats.month} />
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <p className="text-sm font-medium text-gray-700 mb-2">
          Автоответы без вас: {autoReplyPct}%
        </p>
        <div className="w-full bg-gray-100 rounded-full h-2">
          <div
            className="bg-emerald-500 h-2 rounded-full transition-all"
            style={{ width: `${autoReplyPct}%` }}
          />
        </div>
      </div>

      {data.unhandledCount > 0 && (
        <div
          className="bg-orange-50 border border-orange-100 rounded-xl p-4 flex items-center justify-between cursor-pointer"
          onClick={() => onNavigate('faq')}
        >
          <p className="text-sm text-orange-700">
            ⚠ {data.unhandledCount} {data.unhandledCount === 1 ? 'вопрос' : 'вопроса'} от гостей без ответа
          </p>
          <span className="text-sm text-orange-600 font-medium">Посмотреть →</span>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Последние диалоги</h3>
        <DialogueList dialogues={data.recentDialogues} />
      </div>
    </div>
  )
}
