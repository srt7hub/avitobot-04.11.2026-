import { Router } from 'express'
import prisma from '../../prisma.js'
import { setBotDisabled } from '../../services/memoryService.js'

const router = Router()

// Пауза активна, только если pausedUntil ещё в будущем. Поле не обнуляется при
// истечении, поэтому проверка на !== null пометила бы диалог «человек ведёт»
// навсегда после первой же авто-паузы.
function isPauseActive(pausedUntil: Date | null): boolean {
  return pausedUntil !== null && pausedUntil > new Date()
}

router.get('/dialogues', async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10))
  const limit = 20
  const offset = (page - 1) * limit

  try {
    const total = await prisma.dialogue.count({ where: { tenantId } })
    const rows = await prisma.dialogue.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
      skip: offset,
      take: limit,
      include: {
        property: { select: { name: true } },
        messages: {
          orderBy: { processedAt: 'desc' },
          take: 1,
        },
      },
    }) as any[]

    res.json({
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      dialogues: rows.map((d: any) => ({
        id: d.id,
        guestName: d.guestName || 'Гость',
        avitoChatId: d.avitoChatId,
        propertyName: d.property?.name ?? null,
        messageCount: d.messageCount,
        lastMessageAt: d.lastMessageAt,
        isHumanTakeover: isPauseActive(d.pausedUntil),
        botDisabled: d.botDisabled,
        lastMessage: d.messages[0]
          ? { role: d.messages[0].role, content: d.messages[0].content }
          : null,
        updatedAt: d.updatedAt,
      })),
    })
  } catch (err) {
    console.error('[dialogues] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/dialogues/:id', async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const { id } = req.params

  try {
    const d = await prisma.dialogue.findUnique({
      where: { id },
      include: {
        property: { select: { name: true } },
        messages: {
          orderBy: { processedAt: 'asc' },
        },
      },
    }) as any

    if (!d || d.tenantId !== tenantId) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    res.json({
      id: d.id,
      guestName: d.guestName || 'Гость',
      avitoChatId: d.avitoChatId,
      propertyName: d.property?.name ?? null,
      messageCount: d.messageCount,
      lastMessageAt: d.lastMessageAt,
      isHumanTakeover: isPauseActive(d.pausedUntil),
      botDisabled: d.botDisabled,
      createdAt: d.createdAt,
      messages: d.messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        processedAt: m.processedAt,
      })),
    })
  } catch (err) {
    console.error('[dialogues/:id] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Полное включение/отключение бота в конкретном чате.
router.patch('/dialogues/:id/bot', async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const { id } = req.params
  const { disabled } = req.body ?? {}

  if (typeof disabled !== 'boolean') {
    res.status(400).json({ error: 'disabled must be a boolean' })
    return
  }

  try {
    const d = await prisma.dialogue.findUnique({ where: { id }, select: { tenantId: true } })
    if (!d || d.tenantId !== tenantId) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    await setBotDisabled(id, tenantId, disabled)
    res.json({ botDisabled: disabled })
  } catch (err) {
    console.error('[dialogues/:id/bot] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
