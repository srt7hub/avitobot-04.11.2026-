import { useState, useEffect } from 'react'
import { isAuthenticated, getRole, logout } from './auth'

import Login from './client-panel/Login'
import Dashboard from './client-panel/Dashboard'
import FaqManager from './client-panel/FaqManager'
import Properties from './client-panel/Properties'
import SettingsPage from './client-panel/Settings'
import Dialogues from './client-panel/Dialogues'
import Playground from './client-panel/Playground'

import OpsLayout from './ops-panel/OpsLayout'
import ClientsList from './ops-panel/ClientsList'
import ClientCreate from './ops-panel/ClientCreate'
import ClientDetail from './ops-panel/ClientDetail'

// ─── Client Panel routing ─────────────────────────────────────────────────────

type ClientPage = 'dashboard' | 'faq' | 'properties' | 'settings' | 'dialogues' | 'playground'

const CLIENT_PAGES: ClientPage[] = ['dashboard', 'faq', 'properties', 'settings', 'dialogues', 'playground']

function getClientPage(): ClientPage {
  const hash = window.location.hash.replace('#/', '').replace('#', '')
  return CLIENT_PAGES.includes(hash as ClientPage) ? (hash as ClientPage) : 'dashboard'
}

const CLIENT_NAV: { id: ClientPage; label: string }[] = [
  { id: 'dashboard', label: 'Дашборд' },
  { id: 'faq', label: 'База знаний' },
  { id: 'properties', label: 'Объявления' },
  { id: 'dialogues', label: 'Диалоги' },
  { id: 'settings', label: 'Настройки' },
  { id: 'playground', label: 'Тест бота' },
]

function ClientApp() {
  const [page, setPage] = useState<ClientPage>(getClientPage)

  useEffect(() => {
    function onHash() { setPage(getClientPage()) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  function navigate(p: ClientPage) {
    window.location.hash = `/${p}`
    setPage(p)
  }

  function handleLogout() { logout() }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      {/* Sidebar */}
      <aside className="w-48 shrink-0 bg-white border-r border-gray-100 flex flex-col sticky top-0 h-screen">
        <div className="px-4 py-4 border-b border-gray-100">
          <p className="text-sm font-semibold text-gray-900">AvitoBot</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {CLIENT_NAV.map(item => (
            <button
              key={item.id}
              onClick={() => navigate(item.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                page === item.id
                  ? 'bg-gray-100 text-gray-900 font-medium'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="px-2 py-3 border-t border-gray-100">
          <button
            onClick={handleLogout}
            className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Выйти
          </button>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-6">
          {page === 'dashboard' && <Dashboard onNavigate={navigate} />}
          {page === 'faq' && <FaqManager />}
          {page === 'properties' && <Properties />}
          {page === 'dialogues' && <Dialogues />}
          {page === 'settings' && <SettingsPage />}
          {page === 'playground' && <Playground />}
        </div>
      </main>
    </div>
  )
}

// ─── Ops Panel routing ────────────────────────────────────────────────────────

type OpsView =
  | { type: 'list' }
  | { type: 'create' }
  | { type: 'detail'; tenantId: string; fresh?: boolean }

function OpsApp() {
  const [view, setView] = useState<OpsView>({ type: 'list' })

  const opsPage = view.type === 'list' || view.type === 'detail' ? 'clients' : 'create'

  return (
    <OpsLayout page={opsPage} onNavigate={() => setView({ type: 'list' })}>
      {view.type === 'list' && (
        <ClientsList
          onOpen={id => setView({ type: 'detail', tenantId: id })}
          onCreate={() => setView({ type: 'create' })}
        />
      )}
      {view.type === 'create' && (
        <ClientCreate
          onCreated={id => setView({ type: 'detail', tenantId: id, fresh: true })}
          onCancel={() => setView({ type: 'list' })}
        />
      )}
      {view.type === 'detail' && (
        <ClientDetail
          tenantId={view.tenantId}
          onBack={() => setView({ type: 'list' })}
          createdJustNow={view.fresh}
        />
      )}
    </OpsLayout>
  )
}

// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [authed, setAuthed] = useState(isAuthenticated)

  useEffect(() => {
    // После OAuth редиректа от Авито — сохраняем результат и переходим на настройки
    const params = new URLSearchParams(window.location.search)
    const avitoOauth = params.get('avito_oauth')
    if (avitoOauth) {
      sessionStorage.setItem('avito_oauth_result', JSON.stringify({
        ok: avitoOauth === 'success',
        reason: params.get('reason') ?? undefined,
      }))
      window.history.replaceState({}, '', '/#/settings')
      window.location.hash = '#/settings'
    }

    function onHash() { setAuthed(isAuthenticated()) }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!authed) return <Login />

  const role = getRole()
  if (role === 'OPS') return <OpsApp />
  return <ClientApp />
}
