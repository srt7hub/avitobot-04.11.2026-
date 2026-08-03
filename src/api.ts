import { getToken, logout } from './auth'

const BASE = '/api'

function authHeaders(): HeadersInit {
  const token = getToken()
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' }
}

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  })
  if (res.status === 401) {
    logout()
    return null
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

// Auth

export async function apiLogin(email: string, password: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const data = await res.json()
  return { ok: res.ok, data }
}

// Dashboard

export interface DashboardData {
  bot: { isRunning: boolean; lastPollAt: string | null; errorCount: number }
  stats: { today: number; week: number; month: number; autoReplyRate: number }
  recentDialogues: {
    id: string
    guestName: string
    lastMessage: string
    wasHumanTakeover: boolean
    updatedAt: string
  }[]
  unhandledCount: number
}

export function fetchDashboard() {
  return request<DashboardData>('/client/dashboard')
}

export function botStart() {
  return request('/client/bot/start', { method: 'POST' })
}

export function botStop() {
  return request('/client/bot/stop', { method: 'POST' })
}

// FAQ

export interface FaqEntry {
  id: string
  question: string
  answer: string
  propertyId: string | null
  isActive: boolean
  createdAt: string
}

export interface FaqData {
  global: FaqEntry[]
  byProperty: Record<string, FaqEntry[]>
}

export interface UnhandledQuestion {
  id: string
  question: string
  createdAt: string
}

export function fetchFaq() {
  return request<FaqData>('/client/faq')
}

export function createFaq(payload: { question: string; answer: string; propertyId?: string }) {
  return request<FaqEntry>('/client/faq', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateFaq(id: string, payload: { question?: string; answer?: string; isActive?: boolean }) {
  return request<FaqEntry>(`/client/faq/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteFaq(id: string) {
  return request(`/client/faq/${id}`, { method: 'DELETE' })
}

export function fetchUnhandled() {
  return request<UnhandledQuestion[]>('/client/faq/unhandled')
}

export function resolveUnhandled(id: string, answer: string) {
  return request<FaqEntry>(`/client/faq/unhandled/${id}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ answer }),
  })
}

// Properties

export interface Property {
  id: string
  name: string
  address: string
  description: string
  avitoItemId: string | null
  isActive: boolean
}

export function fetchProperties() {
  return request<Property[]>('/client/properties')
}

export function createProperty(payload: { name: string; address: string; description: string }) {
  return request<Property>('/client/properties', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateProperty(
  id: string,
  payload: { name?: string; address?: string; description?: string; isActive?: boolean }
) {
  return request<Property>(`/client/properties/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export interface AvitoItem {
  id: number
  title: string
  price: number | null
  address: string | null
  images: Array<{ '208x156'?: string; '640x480'?: string; '1280x960'?: string }>
  status: string
  url: string
}

export function fetchAvitoItems() {
  return request<{ items: AvitoItem[] }>('/client/properties/avito-data')
}

// Объявления Авито с привязанным propertyId (для фильтра в Базе знаний)
export interface Listing {
  propertyId: string
  avitoItemId: string
  title: string
  address: string | null
  status: string
  price: number | null
  url: string
}

export function fetchListings() {
  return request<{ listings: Listing[] }>('/client/properties/listings')
}

// ─── OPS API ──────────────────────────────────────────────────────────────────

export interface OpsClientSummary {
  id: string
  name: string
  slug: string
  status: string
  bot: { isRunning: boolean; lastPollAt: string | null; errorCount: number; todayMessages: number }
  hasAvitoConfig: boolean
  createdAt: string
}

export interface OpsClientDetail {
  tenant: {
    id: string; name: string; slug: string; botName: string; status: string; customPrompt: string | null
  }
  avitoConfig: {
    avitoClientId: string; avitoClientSecret: string; avitoUserId: string; refreshToken: string
  } | null
  properties: Property[]
  botSession: { isRunning: boolean; errorCount: number; lastError: string; messagesDay: number; messagesWeek: number; messagesMonth: number; autoReplyRate: number } | null
  recentErrors: string[]
  stats: { totalFaq: number; totalProperties: number; totalDialogues: number }
}

export interface OpsStatus {
  totalClients: number; runningBots: number; errorBots: number; totalMessagesToday: number
}

export interface OpsDialogue {
  id: string; guestName: string; updatedAt: string; pausedUntil: string | null
  messages: { content: string; role: string; processedAt: string }[]
}

export interface OpsMessage {
  id: string; role: string; content: string; processedAt: string
}

export function opsGetStatus() {
  return request<OpsStatus>('/ops/status')
}

export function opsListClients() {
  return request<{ clients: OpsClientSummary[] }>('/ops/clients')
}

export function opsGetClient(tenantId: string) {
  return request<OpsClientDetail>(`/ops/clients/${tenantId}`)
}

export function opsCreateClient(payload: {
  name: string; slug: string; botName?: string
  managerEmail: string; managerPassword: string; managerName?: string; telegramContact?: string
}) {
  return request<{ tenantId: string }>('/ops/clients', { method: 'POST', body: JSON.stringify(payload) })
}

export function opsUpdateClient(tenantId: string, payload: { name?: string; botName?: string; status?: string }) {
  return request(`/ops/clients/${tenantId}`, { method: 'PUT', body: JSON.stringify(payload) })
}

export function opsListFaq(tenantId: string) {
  return request<FaqEntry[]>(`/ops/clients/${tenantId}/faq`)
}

export function opsCreateFaq(tenantId: string, payload: { question: string; answer: string; propertyId?: string }) {
  return request<FaqEntry>(`/ops/clients/${tenantId}/faq`, { method: 'POST', body: JSON.stringify(payload) })
}

export function opsUpdateFaq(tenantId: string, faqId: string, payload: { question?: string; answer?: string; isActive?: boolean }) {
  return request<FaqEntry>(`/ops/clients/${tenantId}/faq/${faqId}`, { method: 'PUT', body: JSON.stringify(payload) })
}

export function opsDeleteFaq(tenantId: string, faqId: string) {
  return request(`/ops/clients/${tenantId}/faq/${faqId}`, { method: 'DELETE' })
}

export function opsGetPrompt(tenantId: string) {
  return request<{
    basePrompt: string
    customPrompt: string
    effectivePrompt: string
    isCustom: boolean
  }>(`/ops/clients/${tenantId}/prompt`)
}

// prompt здесь = customPrompt клиента (доп. инструкция). Пустая строка сбрасывает.
export function opsSavePrompt(tenantId: string, prompt: string) {
  return request(`/ops/clients/${tenantId}/prompt`, { method: 'PUT', body: JSON.stringify({ prompt }) })
}

export function opsListProperties(tenantId: string) {
  return request<Property[]>(`/ops/clients/${tenantId}/properties`)
}

export function opsCreateProperty(tenantId: string, payload: { name: string; address: string; description: string; avitoItemId?: string }) {
  return request<Property>(`/ops/clients/${tenantId}/properties`, { method: 'POST', body: JSON.stringify(payload) })
}

export function opsUpdateProperty(tenantId: string, propertyId: string, payload: { name?: string; address?: string; description?: string; avitoItemId?: string; isActive?: boolean }) {
  return request<Property>(`/ops/clients/${tenantId}/properties/${propertyId}`, { method: 'PUT', body: JSON.stringify(payload) })
}

export function opsSaveAvitoConfig(tenantId: string, payload: { avitoClientId: string; avitoClientSecret: string; avitoUserId: string; refreshToken?: string }) {
  return request(`/ops/clients/${tenantId}/avito`, { method: 'PUT', body: JSON.stringify(payload) })
}

export function opsTestAvito(tenantId: string) {
  return request<{ ok: boolean; chatCount?: number; error?: string }>(`/ops/clients/${tenantId}/avito/test`, { method: 'POST' })
}

export function opsBotRestart(tenantId: string) {
  return request(`/ops/clients/${tenantId}/bot/restart`, { method: 'POST' })
}

export function opsListDialogues(tenantId: string) {
  return request<OpsDialogue[]>(`/ops/clients/${tenantId}/dialogues`)
}

export function opsGetMessages(tenantId: string, dialogueId: string) {
  return request<OpsMessage[]>(`/ops/clients/${tenantId}/dialogues/${dialogueId}/messages`)
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface Settings {
  botName: string
  customPrompt: string
  telegramContact: string
  avitoClientId: string
  avitoUserId: string
  telegramChatId: string
  telegramBotToken: string
  avitoClientSecret: string
}

export function fetchSettings() {
  return request<Settings>('/client/settings')
}

export function updateSettings(payload: { botName?: string; telegramContact?: string; customPrompt?: string }) {
  return request('/client/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

// ─── Playground (тест бота) ─────────────────────────────────────────────────

export function playgroundReply(body: {
  messages: { role: 'user' | 'assistant'; content: string }[]
  propertyId?: string
  phase?: string
}) {
  return request<{ reply: string }>('/client/playground/reply', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function updateAvitoConfig(payload: { avitoClientId: string; avitoClientSecret: string; avitoUserId: string }) {
  return request('/client/settings/avito', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function checkAvitoConnection() {
  return request<{ ok: boolean; error?: string }>('/client/settings/avito-check')
}

export function fetchAvitoOAuthUrl() {
  return request<{ url: string }>('/client/settings/avito-oauth/url')
}

export function updateTelegramConfig(payload: { telegramBotToken?: string; telegramChatId?: string }) {
  return request('/client/settings/telegram', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function testTelegramConnection() {
  return request<{ ok: boolean; error?: string }>('/client/settings/telegram-test', { method: 'POST' })
}

// ─── Dialogues ────────────────────────────────────────────────────────────────

export interface DialogueSummary {
  id: string
  guestName: string
  avitoChatId: string
  propertyName: string | null
  messageCount: number
  lastMessageAt: string | null
  isHumanTakeover: boolean
  botDisabled: boolean
  lastMessage: { role: string; content: string } | null
  updatedAt: string
}

export interface DialogueMessage {
  id: string
  role: 'GUEST' | 'BOT'
  content: string
  processedAt: string
}

export interface DialogueFull {
  id: string
  guestName: string
  avitoChatId: string
  propertyName: string | null
  messageCount: number
  lastMessageAt: string | null
  isHumanTakeover: boolean
  botDisabled: boolean
  createdAt: string
  messages: DialogueMessage[]
}

export interface DialoguesPage {
  total: number
  page: number
  pages: number
  dialogues: DialogueSummary[]
}

export function fetchDialogues(page = 1) {
  return request<DialoguesPage>(`/client/dialogues?page=${page}`)
}

export function fetchDialogue(id: string) {
  return request<DialogueFull>(`/client/dialogues/${id}`)
}

export function setDialogueBot(id: string, disabled: boolean) {
  return request<{ botDisabled: boolean }>(`/client/dialogues/${id}/bot`, {
    method: 'PATCH',
    body: JSON.stringify({ disabled }),
  })
}

// Calendar

export interface CalendarInterval {
  id: string
  kind: 'booking' | 'block'
  platform: string
  guestName: string
  start: string
  end: string
  totalPrice: number
  isPaid: boolean
}

export interface CalendarSyncInfo {
  id: string
  platform: string
  importUrl: string
  isActive: boolean
  lastSyncAt: string | null
  lastSyncStatus: string
  lastSyncError: string
  lastEventCount: number
}

export interface CalendarProperty {
  propertyId: string
  name: string
  address: string
  avitoItemId: string
  hasFeed: boolean
  syncs: CalendarSyncInfo[]
  intervals: CalendarInterval[]
}

export interface CalendarData {
  from: string
  to: string
  properties: CalendarProperty[]
}

export function fetchCalendar(from?: string, to?: string) {
  const qs = new URLSearchParams()
  if (from) qs.set('from', from)
  if (to) qs.set('to', to)
  const suffix = qs.toString() ? `?${qs}` : ''
  return request<CalendarData>(`/client/calendar${suffix}`)
}

export function addCalendarSync(propertyId: string, platform: string, importUrl: string) {
  return request<{ sync: { id: string; platform: string }; result: unknown }>('/client/calendar/syncs', {
    method: 'POST',
    body: JSON.stringify({ propertyId, platform, importUrl }),
  })
}

export function deleteCalendarSync(id: string) {
  return request<{ ok: boolean }>(`/client/calendar/syncs/${id}`, { method: 'DELETE' })
}

export function syncCalendars() {
  return request<{ ok: boolean; synced: number; failed: number }>('/client/calendar/sync', {
    method: 'POST',
  })
}

export function createCalendarFeed(propertyId: string, rotate = false) {
  return request<{ token: string; url: string }>('/client/calendar/feed', {
    method: 'POST',
    body: JSON.stringify({ propertyId, rotate }),
  })
}
