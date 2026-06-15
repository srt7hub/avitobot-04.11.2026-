import { Router } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import prisma from '../../prisma.js'
import { buildSystemPrompt, generateReply } from '../../services/aiService.js'
import { getFaqForProperty } from '../../services/faqService.js'
import type { GuestPhase } from '../../utils/guestPhase.js'

const router = Router()

// Допустимые фазы для тестового сценария (см. guestPhase.ts). Песочница не
// вычисляет фазу из брони — клиент выбирает её вручную, поэтому валидируем вход.
const VALID_PHASES: readonly GuestPhase[] = [
  'NO_BOOKING',
  'AWAITING_PAYMENT',
  'PAID_BEFORE',
  'CHECK_IN_DAY',
  'STAYING',
  'CHECKOUT_DAY',
  'POST_STAY_QUIET',
  'POST_STAY_ACTIVE',
  'POST_STAY_OLD',
]

// AI-эндпоинт дорогой — отдельный, более строгий лимит поверх глобального.
const playgroundLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Авторизованный эндпоинт: обычно ключ — userId. Фолбэк на IP нормализуем
  // через ipKeyGenerator, иначе IPv6-клиенты могут обходить лимит (ERR_ERL_KEY_GEN_IPV6).
  keyGenerator: (req) => req.auth?.userId ?? (req.ip ? ipKeyGenerator(req.ip) : 'anon'),
  message: { error: 'Слишком много запросов к тесту бота, подождите немного' },
})

type PlaygroundMessage = { role: 'user' | 'assistant'; content: string }

/**
 * POST /api/client/playground/reply
 * Песочница: эфемерный тестовый диалог. НЕ персистит ничего (Dialogue/Message),
 * НЕ ходит в Авито/Telegram. Собирает тот же системный промпт, что и прод-бот
 * (customPrompt + FAQ + данные объекта + фаза), и возвращает ответ ИИ.
 */
router.post('/playground/reply', playgroundLimiter, async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const { messages, propertyId, phase } = req.body as {
    messages?: PlaygroundMessage[]
    propertyId?: string
    phase?: string
  }

  // ─── Валидация ──────────────────────────────────────────────────────────────
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages обязателен и не должен быть пустым' })
    return
  }
  if (messages.length > 30) {
    res.status(400).json({ error: 'Слишком длинный диалог (максимум 30 сообщений)' })
    return
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      res.status(400).json({ error: 'Некорректный формат сообщения' })
      return
    }
    if (m.content.length > 1000) {
      res.status(400).json({ error: 'Сообщение слишком длинное (максимум 1000 символов)' })
      return
    }
  }
  const last = messages[messages.length - 1]
  if (last.role !== 'user' || !last.content.trim()) {
    res.status(400).json({ error: 'Последнее сообщение должно быть от гостя и не пустым' })
    return
  }

  if (phase !== undefined && !VALID_PHASES.includes(phase as GuestPhase)) {
    res.status(400).json({ error: 'Неизвестная фаза' })
    return
  }

  try {
    // ─── Загрузка контекста тенанта ────────────────────────────────────────────
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' })
      return
    }

    // Объект: если передан propertyId — строго в рамках тенанта (изоляция!);
    // иначе первый активный объект тенанта или null.
    const property = propertyId
      ? await prisma.property.findFirst({ where: { id: propertyId, tenantId } })
      : await prisma.property.findFirst({
          where: { tenantId, isActive: true },
          orderBy: { createdAt: 'asc' },
        })

    // FAQ: глобальные тенанта + привязанные к выбранному объекту (как в проде).
    const faqEntries = await getFaqForProperty(tenantId, property?.id)

    // ─── Сборка промпта ровно как в проде (bot.ts) ──────────────────────────────
    const systemPrompt = buildSystemPrompt({
      botName: tenant.botName,
      property: property
        ? {
            name: property.name,
            address: property.address,
            description: property.description,
            doorCode: property.doorCode,
            wifiName: property.wifiName,
            wifiPassword: property.wifiPassword,
            checkInInstructions: property.checkInInstructions,
          }
        : null,
      faqEntries: faqEntries.map(f => ({ question: f.question, answer: f.answer })),
      memorySummary: '', // в песочнице памяти диалога нет
      phase: (phase as GuestPhase) ?? 'NO_BOOKING',
      customPrompt: tenant.customPrompt,
    })

    const reply = await generateReply(messages, systemPrompt)
    res.json({ reply })
  } catch (err) {
    // Не роняем 500 с трейсом наружу — это вызов внешнего AI, частая причина — он сам.
    console.error('[playground/reply] error:', err)
    res.status(502).json({ error: 'AI временно недоступен, попробуйте ещё раз' })
  }
})

export default router
