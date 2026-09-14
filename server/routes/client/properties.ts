import { Router } from 'express'
import prisma from '../../prisma.js'
import { sendOpsAlert } from '../../services/telegramService.js'
import { getItemsByUser, TenantAvitoConfig } from '../../services/avitoService.js'

const router = Router()

router.get('/properties/avito-data', async (req, res) => {
  const tenantId = req.auth!.tenantId!

  try {
    const avitoConfig = await prisma.tenantAvitoConfig.findUnique({ where: { tenantId } })
    if (!avitoConfig?.accessToken) {
      res.json({ items: [] })
      return
    }

    const items = await getItemsByUser(avitoConfig as TenantAvitoConfig)
    res.json({ items })
  } catch (err) {
    console.error('[properties/avito-data GET] error:', err)
    res.status(500).json({ error: 'Не удалось загрузить данные с Авито' })
  }
})

// Объявления Авито + привязанный к каждому Property (автосоздаётся при отсутствии).
// Используется фильтром «Объект» в Базе знаний: список = объявления, FAQ привязан к Property.
router.get('/properties/listings', async (req, res) => {
  const tenantId = req.auth!.tenantId!

  try {
    const avitoConfig = await prisma.tenantAvitoConfig.findUnique({ where: { tenantId } })
    if (!avitoConfig?.accessToken) {
      res.json({ listings: [] })
      return
    }

    const items = await getItemsByUser(avitoConfig as TenantAvitoConfig)

    const existing = await prisma.property.findMany({ where: { tenantId } })
    const byAvitoId = new Map(existing.filter(p => p.avitoItemId).map(p => [p.avitoItemId, p]))

    const listings = []
    for (const item of items) {
      const avitoItemId = String(item.id)
      let property = byAvitoId.get(avitoItemId)
      if (!property) {
        property = await prisma.property.create({
          data: {
            tenantId,
            name: item.title,
            address: item.address ?? '',
            avitoItemId,
            isActive: true,
          },
        })
        byAvitoId.set(avitoItemId, property)
      }
      listings.push({
        propertyId: property.id,
        avitoItemId,
        title: item.title,
        address: item.address,
        status: item.status,
        price: item.price,
        url: item.url,
      })
    }

    res.json({ listings })
  } catch (err) {
    console.error('[properties/listings GET] error:', err)
    res.status(500).json({ error: 'Не удалось загрузить объявления' })
  }
})

router.get('/properties', async (req, res) => {
  const tenantId = req.auth!.tenantId!

  try {
    const properties = await prisma.property.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: 'asc' },
    })
    res.json(properties)
  } catch (err) {
    console.error('[properties GET] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/properties', async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const { name, address, description, intercomCode, mapUrl, doorCode, wifiName, wifiPassword, checkInInstructions } = req.body as {
    name?: string
    address?: string
    description?: string
    intercomCode?: string
    mapUrl?: string
    doorCode?: string
    wifiName?: string
    wifiPassword?: string
    checkInInstructions?: string
  }

  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' })
    return
  }

  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
    const property = await prisma.property.create({
      data: {
        tenantId,
        name: name.trim(),
        address: address?.trim() ?? '',
        description: description?.trim() ?? '',
        intercomCode: intercomCode?.trim() ?? '',
        mapUrl: mapUrl?.trim() ?? '',
        doorCode: doorCode?.trim() ?? '',
        wifiName: wifiName?.trim() ?? '',
        wifiPassword: wifiPassword?.trim() ?? '',
        checkInInstructions: checkInInstructions?.trim() ?? '',
        isActive: false,
      },
    })

    await sendOpsAlert(
      `Новый объект от клиента ${tenant?.name ?? tenantId}: "${property.name}", ${property.address || 'адрес не указан'}`
    )

    res.status(201).json(property)
  } catch (err) {
    console.error('[properties POST] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/properties/:id', async (req, res) => {
  const tenantId = req.auth!.tenantId!
  const { id } = req.params
  const { name, address, description, isActive, intercomCode, mapUrl, doorCode, wifiName, wifiPassword, checkInInstructions } = req.body as {
    name?: string
    address?: string
    description?: string
    isActive?: boolean
    intercomCode?: string
    mapUrl?: string
    doorCode?: string
    wifiName?: string
    wifiPassword?: string
    checkInInstructions?: string
  }

  const property = await prisma.property.findFirst({ where: { id, tenantId } })
  if (!property) {
    res.status(404).json({ error: 'Not found' })
    return
  }

  try {
    const updated = await prisma.property.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(address !== undefined && { address: address.trim() }),
        ...(description !== undefined && { description: description.trim() }),
        ...(intercomCode !== undefined && { intercomCode: intercomCode.trim() }),
        ...(mapUrl !== undefined && { mapUrl: mapUrl.trim() }),
        ...(doorCode !== undefined && { doorCode: doorCode.trim() }),
        ...(wifiName !== undefined && { wifiName: wifiName.trim() }),
        ...(wifiPassword !== undefined && { wifiPassword: wifiPassword.trim() }),
        ...(checkInInstructions !== undefined && { checkInInstructions: checkInInstructions.trim() }),
        ...(isActive !== undefined && { isActive }),
        // avitoItemId не редактируется клиентом — только OPS
      },
    })
    res.json(updated)
  } catch (err) {
    console.error('[properties PUT] error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
