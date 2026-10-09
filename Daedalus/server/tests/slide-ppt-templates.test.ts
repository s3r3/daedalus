import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { EventBus, TaskStore, newDeck, readDeck, writeDeck } from '@daedalus/core'
import { createContext, createApp, attachWebSocket, type EventChannel } from '../src/app.ts'

/**
 * "Template dari PPT" server surface: upload a .pptx, list/apply/delete
 * the extracted template. The deck theme commit flows through the same
 * /slides/deck/theme endpoint as bundled templates (last pick wins).
 */

let server: ReturnType<typeof createApp> | undefined
let channel: EventChannel | undefined
let tmp: string | undefined
let workspace: string | undefined

afterEach(async () => {
  channel?.close()
  channel = undefined
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

async function listen(): Promise<{ base: string; root: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'daedalus-ppttpl-'))
  workspace = mkdtempSync(join(tmpdir(), 'daedalus-ppttpl-ws-'))
  const ctx = createContext({ store: new TaskStore(join(tmp, 'state')), bus: new EventBus(), cwd: workspace })
  server = createApp(ctx)
  channel = attachWebSocket(ctx, server)
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { base: `http://127.0.0.1:${port}`, root: workspace }
}

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Emerald Gold">
  <a:themeElements>
    <a:clrScheme name="Emerald">
      <a:dk1><a:sysClr val="windowText" lastClr="101418"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="F7F3E8"/></a:lt1>
      <a:accent1><a:srgbClr val="C59A46"/></a:accent1>
      <a:accent2><a:srgbClr val="2E7D5C"/></a:accent2>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
    </a:clrScheme>
    <a:fontScheme name="Emerald">
      <a:majorFont><a:latin typeface="Georgia"/></a:majorFont>
      <a:minorFont><a:latin typeface="Verdana"/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`

async function syntheticPptx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  zip.file('ppt/theme/theme1.xml', THEME_XML)
  zip.file(
    'ppt/slideMasters/slideMaster1.xml',
    `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="0F2D1E"/></a:solidFill></p:bgPr></p:bg></p:sldMaster>`,
  )
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function uploadPptx(base: string, root: string, fileName: string, bytes: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
  const form = new FormData()
  form.set('root', root)
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), fileName)
  const res = await fetch(new URL('/slides/ppt-templates', base), { method: 'POST', body: form })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function req(base: string, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function seedDeck(root: string): Promise<void> {
  const deck = newDeck('Deck Uji')
  deck.slides.push({ id: 's-1', layout: 'bullets', content: { title: 'Satu', points: ['a'] } })
  await writeDeck(root, deck)
}

describe('/slides/ppt-templates', () => {
  test('upload → list → apply → delete round trip through the real endpoints', async () => {
    const { base, root } = await listen()
    await seedDeck(root)

    const uploaded = await uploadPptx(base, root, 'Emerald Gold.pptx', await syntheticPptx())
    expect(uploaded.status).toBe(201)
    const template = uploaded.body.template as { id: string; theme: { accent?: string }; slideSize?: { label: string } }
    expect(template.id).toBe('emerald-gold')
    expect(template.theme.accent).toBe('#c59a46')
    expect(template.slideSize?.label).toBe('16:9')
    expect(existsSync(join(root, '.daedalus', 'slide-templates', 'emerald-gold.json'))).toBe(true)

    const list = await req(base, 'GET', `/slides/ppt-templates?root=${encodeURIComponent(root)}`)
    expect(list.status).toBe(200)
    expect((list.body.templates as unknown[]).length).toBe(1)

    // Apply through the shared theme endpoint: the deck restyles wholesale.
    const applied = await req(base, 'POST', '/slides/deck/theme', { root, custom_template_id: 'emerald-gold' })
    expect(applied.status).toBe(200)
    const deckAfter = (applied.body.deck as { theme: Record<string, unknown> }).theme
    expect(deckAfter.customTemplateId).toBe('emerald-gold')
    expect(deckAfter.background).toBe('#0f2d1e')
    expect(deckAfter.templateId).toBeUndefined()
    expect((await readDeck(root))?.theme.headingFont).toBe('Georgia')

    // A bundled pick afterwards wins back (theme replaced wholesale).
    const bundled = await req(base, 'POST', '/slides/deck/theme', { root, template_id: 'ocean' })
    expect(bundled.status).toBe(200)
    const bundledTheme = (bundled.body.deck as { theme: Record<string, unknown> }).theme
    expect(bundledTheme.templateId).toBe('ocean')
    expect(bundledTheme.customTemplateId).toBeUndefined()

    const deleted = await req(base, 'POST', '/slides/ppt-templates/delete', { root, id: 'emerald-gold' })
    expect(deleted.status).toBe(200)
    const listAfter = await req(base, 'GET', `/slides/ppt-templates?root=${encodeURIComponent(root)}`)
    expect((listAfter.body.templates as unknown[]).length).toBe(0)
    const deleteAgain = await req(base, 'POST', '/slides/ppt-templates/delete', { root, id: 'emerald-gold' })
    expect(deleteAgain.status).toBe(404)
  })

  test('non-pptx uploads are refused honestly and nothing is stored', async () => {
    const { base, root } = await listen()
    const garbage = await uploadPptx(base, root, 'Bukan PPT.pptx', Buffer.from('plain text, not a zip'))
    expect(garbage.status).toBe(400)
    expect(garbage.body.error).toBe('not_a_pptx')

    const wrongExt = await uploadPptx(base, root, 'Dokumen.pdf', await syntheticPptx())
    expect(wrongExt.status).toBe(400)
    expect(wrongExt.body.error).toBe('not_a_pptx')

    const list = await req(base, 'GET', `/slides/ppt-templates?root=${encodeURIComponent(root)}`)
    expect((list.body.templates as unknown[]).length).toBe(0)
    expect(existsSync(join(root, '.daedalus', 'slide-templates'))).toBe(false)
  })

  test('applying an unknown imported template is a named 404; a missing deck stays 404', async () => {
    const { base, root } = await listen()
    await seedDeck(root)
    const unknown = await req(base, 'POST', '/slides/deck/theme', { root, custom_template_id: 'tidak-ada' })
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe('ppt_template_not_found')

    const bare = await listen()
    const noDeck = await req(bare.base, 'POST', '/slides/deck/theme', { root: bare.root, custom_template_id: 'tidak-ada' })
    expect(noDeck.status).toBe(404)
  })

  test('the exported pptx of a restyled deck carries the extracted background', async () => {
    const { base, root } = await listen()
    await seedDeck(root)
    await uploadPptx(base, root, 'Emerald Gold.pptx', await syntheticPptx())
    await req(base, 'POST', '/slides/deck/theme', { root, custom_template_id: 'emerald-gold' })

    const exported = await req(base, 'POST', '/slides/deck/export', { root })
    expect(exported.status).toBe(200)
    const out = await JSZip.loadAsync(readFileSync(join(root, String(exported.body.path))))
    const slide1 = await out.file('ppt/slides/slide1.xml')?.async('string')
    expect(slide1).toContain('0F2D1E')
  })
})

/* ---------------------------------------------------------- v2 pages */

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function spText(text: string, size: number, x = 1219200, y = 685800, w = 7315200, h = 1371600): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="${size}"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Georgia"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
}

/** One slide: image background + big title + a picture slot. */
async function pagedPptx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`)
  zip.file('ppt/theme/theme1.xml', THEME_XML)
  zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sldMaster>`)
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/theme" Target="../theme/theme1.xml"/></Relationships>`)
  zip.file('ppt/media/image1.png', PNG_1PX)
  zip.file('ppt/media/image2.png', PNG_1PX)
  const picXml = `<p:pic><p:nvPicPr><p:cNvPr id="9" name="Pic"/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="7560000" y="1371600"/><a:ext cx="3897600" cy="4114800"/></a:xfrm></p:spPr></p:pic>`
  zip.file('ppt/slides/slide1.xml', `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${spText('Judul Sampel', 4400)}${picXml}</p:spTree></p:cSld></p:sld>`)
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/><Relationship Id="rId3" Type="${REL}/image" Target="../media/image2.png"/></Relationships>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('/slides/ppt-templates v2 (pages)', () => {
  test('upload parses pages; the asset endpoint serves referenced page assets only', async () => {
    const { base, root } = await listen()
    const uploaded = await uploadPptx(base, root, 'Berhalaman.pptx', await pagedPptx())
    expect(uploaded.status).toBe(201)
    const template = uploaded.body.template as { id: string; pages?: Array<{ kind: string; slots: unknown[] }> }
    expect(template.id).toBe('berhalaman')
    expect(template.pages).toHaveLength(1)
    expect(template.pages?.[0]?.kind).toBe('cover')
    expect(template.pages?.[0]?.slots).toHaveLength(2)

    const bgRes = await fetch(new URL(`/slides/ppt-templates/asset?root=${encodeURIComponent(root)}&id=berhalaman&file=${encodeURIComponent('berhalaman.page-0.background.png')}`, base))
    expect(bgRes.status).toBe(200)
    expect(bgRes.headers.get('content-type')).toContain('image/png')
    expect(Buffer.from(await bgRes.arrayBuffer()).length).toBe(PNG_1PX.length)

    const picRes = await fetch(new URL(`/slides/ppt-templates/asset?root=${encodeURIComponent(root)}&id=berhalaman&file=${encodeURIComponent('berhalaman.page-0.pic-0.png')}`, base))
    expect(picRes.status).toBe(200)

    // Unreferenced names and traversal attempts are 404, never file reads.
    const jsonRes = await req(base, 'GET', `/slides/ppt-templates/asset?root=${encodeURIComponent(root)}&id=berhalaman&file=berhalaman.json`)
    expect(jsonRes.status).toBe(404)
    const traversalRes = await req(base, 'GET', `/slides/ppt-templates/asset?root=${encodeURIComponent(root)}&id=berhalaman&file=${encodeURIComponent('../deck/deck.json')}`)
    expect(traversalRes.status).toBe(404)
    const unknownTemplate = await req(base, 'GET', `/slides/ppt-templates/asset?root=${encodeURIComponent(root)}&id=tidak-ada&file=x.png`)
    expect(unknownTemplate.status).toBe(404)
  })

  test('task submit refuses bundled+imported template together, and unknown imported templates', async () => {
    const { base, root } = await listen()
    await seedDeck(root)
    const conflict = await req(base, 'POST', '/tasks', { goal: 'buatkan slide', domain: 'slide', slide: { template_id: 'ocean', custom_template_id: 'emerald-gold' } })
    expect(conflict.status).toBe(400)
    expect(conflict.body.error).toBe('slide_template_conflict')

    const unknown = await req(base, 'POST', '/tasks', { goal: 'buatkan slide', domain: 'slide', repo_path: root, slide: { custom_template_id: 'tidak-ada' } })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toBe('unknown_ppt_template')
  })
})
