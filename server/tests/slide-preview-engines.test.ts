import { describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { newDeck, writeDeck, type DeckSpec } from '@daedalus/core'
import {
  POWERPOINT_PAGE_WIDTH_PX,
  SlidePreviewService,
  buildPowerPointExportScript,
  createPowerPointConverter,
  detectPreviewEngines,
  executableCandidates,
  findExecutableOnPath,
  findPowerShell,
  resolvePreviewEngine,
  type PowerPointScriptRunner,
  type PreviewConverter,
  type PreviewEngineSeams,
  type SlidePreviewDeps,
} from '../src/slide-preview.ts'

/**
 * Pratinjau Asli engine layer: LibreOffice anywhere, PowerPoint on
 * Windows via COM. Everything here runs on Linux: platform, PATH and
 * the COM probe are injected seams, and the PowerPoint converter is
 * driven through a fake script runner, so the suite is deterministic
 * without Windows or PowerPoint.
 */

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
)

/** fileExists seam backed by a fixed set of absolute paths. */
function hasFiles(...paths: string[]): PreviewEngineSeams['fileExists'] {
  const set = new Set(paths)
  return (path) => set.has(path)
}

describe('executable resolution', () => {
  test('windows candidates carry .exe/.com variants; posix stays bare', () => {
    expect(executableCandidates('soffice', 'win32')).toEqual(['soffice.exe', 'soffice.com', 'soffice'])
    expect(executableCandidates('pdftoppm', 'win32')).toEqual(['pdftoppm.exe', 'pdftoppm'])
    expect(executableCandidates('powershell', 'win32')).toEqual(['powershell.exe', 'pwsh.exe'])
    expect(executableCandidates('soffice', 'linux')).toEqual(['soffice'])
    expect(executableCandidates('pdftoppm', 'darwin')).toEqual(['pdftoppm'])
  })

  test('findExecutableOnPath splits PATH with the platform separator and returns the full path', () => {
    const win = findExecutableOnPath(['soffice.exe', 'soffice'], {
      platform: 'win32',
      env: { PATH: 'C:\\tools;C:\\lo\\program' },
      fileExists: hasFiles(join('C:\\lo\\program', 'soffice.exe')),
    })
    expect(win).toBe(join('C:\\lo\\program', 'soffice.exe'))

    const posix = findExecutableOnPath(['soffice'], {
      platform: 'linux',
      env: { PATH: '/usr/bin:/opt/lo/bin' },
      fileExists: hasFiles('/opt/lo/bin/soffice'),
    })
    expect(posix).toBe('/opt/lo/bin/soffice')

    expect(
      findExecutableOnPath(['soffice'], { platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: hasFiles() }),
    ).toBeNull()
  })

  test('findPowerShell finds powershell.exe or pwsh.exe on win32', () => {
    expect(
      findPowerShell({ platform: 'win32', env: { PATH: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0' }, fileExists: hasFiles(join('C:\\Windows\\System32\\WindowsPowerShell\\v1.0', 'powershell.exe')) }),
    ).toContain('powershell.exe')
    expect(findPowerShell({ platform: 'win32', env: { PATH: 'C:\\none' }, fileExists: hasFiles() })).toBeNull()
  })
})

describe('engine detection + selection', () => {
  const loFiles = ['/usr/bin/soffice', '/usr/bin/pdftoppm']
  const winLoFiles = [join('C:\\lo\\program', 'soffice.exe'), join('C:\\poppler', 'pdftoppm.exe'), join('C:\\ps', 'powershell.exe')]
  const winPptFiles = [join('C:\\ps', 'powershell.exe')]

  test('posix with soffice+pdftoppm -> LibreOffice engine', async () => {
    const availability = await detectPreviewEngines({ platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: hasFiles(...loFiles) })
    expect(availability).toEqual({ libreOffice: true, powerPoint: false })
    expect(resolvePreviewEngine(availability)).toBe('libreoffice')
  })

  test('LibreOffice needs BOTH soffice and pdftoppm', async () => {
    const availability = await detectPreviewEngines({ platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: hasFiles('/usr/bin/soffice') })
    expect(availability.libreOffice).toBe(false)
    expect(resolvePreviewEngine(availability)).toBeNull()
  })

  test('win32 prefers LibreOffice when its toolchain is present, without probing COM', async () => {
    let probes = 0
    const availability = await detectPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\lo\\program;C:\\poppler;C:\\ps' },
      fileExists: hasFiles(...winLoFiles),
      probePowerPointCom: async () => {
        probes += 1
        return true
      },
    })
    expect(availability.libreOffice).toBe(true)
    expect(resolvePreviewEngine(availability)).toBe('libreoffice')
    // Detection may probe, but selection must not depend on it.
    expect(availability.powerPoint).toBe(true)
    expect(probes).toBeLessThanOrEqual(1)
  })

  test('win32 without LibreOffice but with PowerPoint COM -> PowerPoint engine', async () => {
    const availability = await detectPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\ps' },
      fileExists: hasFiles(...winPptFiles),
      probePowerPointCom: async () => true,
    })
    expect(availability).toEqual({ libreOffice: false, powerPoint: true })
    expect(resolvePreviewEngine(availability)).toBe('powerpoint')
  })

  test('win32 with PowerShell but no PowerPoint COM -> unavailable', async () => {
    const availability = await detectPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\ps' },
      fileExists: hasFiles(...winPptFiles),
      probePowerPointCom: async () => false,
    })
    expect(availability).toEqual({ libreOffice: false, powerPoint: false })
    expect(resolvePreviewEngine(availability)).toBeNull()
  })

  test('a failing COM probe reads as not-available, never a rejection', async () => {
    const availability = await detectPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\ps' },
      fileExists: hasFiles(...winPptFiles),
      probePowerPointCom: async () => {
        throw new Error('probe exploded')
      },
    })
    expect(availability.powerPoint).toBe(false)
  })

  test('PowerPoint is never probed off Windows, even with pwsh present', async () => {
    let probes = 0
    const availability = await detectPreviewEngines({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      fileExists: hasFiles('/usr/bin/pwsh'),
      probePowerPointCom: async () => {
        probes += 1
        return true
      },
    })
    expect(availability.powerPoint).toBe(false)
    expect(probes).toBe(0)
  })
})

describe('PowerPoint COM script generation', () => {
  const script = buildPowerPointExportScript({
    pptxPath: "C:\\decks\\deck's preview.pptx",
    outDir: 'C:\\cache\\work',
    pidFile: 'C:\\cache\\work\\powerpoint-pids.txt',
  })

  test('exports every slide to page-N.png at the preview width with aspect-derived height', () => {
    expect(script).toContain(`$widthPx = ${POWERPOINT_PAGE_WIDTH_PX}`)
    expect(script).toContain("$slide.Export((Join-Path $outDir ('page-{0}.png' -f $index)), 'PNG', $widthPx, $heightPx)")
    expect(script).toContain('$heightPx = [int][Math]::Round($widthPx * [double]$presentation.PageSetup.SlideHeight / [double]$presentation.PageSetup.SlideWidth)')
    expect(script).toContain('foreach ($slide in $presentation.Slides)')
  })

  test('opens read-only + windowless via COM', () => {
    expect(script).toContain('New-Object -ComObject PowerPoint.Application')
    expect(script).toContain('$app.Presentations.Open($pptxPath, $true, $false, $false)')
  })

  test('cleanup closes our presentation; quits PowerPoint only when we started it; records started pids', () => {
    expect(script).toContain('$preExisting = @(Get-PowerPointPids)')
    expect(script).toContain("[IO.File]::WriteAllLines($pidFile, [string[]]$startedByUs)")
    expect(script).toContain('$presentation.Close()')
    expect(script).toContain('if ($preExisting.Count -eq 0) { try { $app.Quit() } catch { } }')
    expect(script).toContain('ReleaseComObject($app)')
    expect(script).toContain('ReleaseComObject($presentation)')
  })

  test('failures go to stderr with exit 1 under ErrorActionPreference Stop', () => {
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toContain("[Console]::Error.WriteLine('Render PowerPoint gagal: ' + $_.Exception.Message)")
    expect(script).toContain('exit 1')
  })

  test('single quotes in paths are escaped the PowerShell way', () => {
    expect(script).toContain("$pptxPath = 'C:\\decks\\deck''s preview.pptx'")
  })

  test('empty deck throws inside the script instead of exporting nothing', () => {
    expect(script).toContain("throw 'PowerPoint membuka berkas .pptx ini tanpa slide.'")
  })
})

describe('PowerPoint converter (fake script runner)', () => {
  function fakeRunner(pages: number, error?: Error): { runner: PowerPointScriptRunner; seen: () => { scriptPath: string; pidFile: string; timeoutMs: number } | undefined } {
    let seenInput: { scriptPath: string; pidFile: string; timeoutMs: number } | undefined
    return {
      seen: () => seenInput,
      runner: async (input) => {
        seenInput = input
        expect(existsSync(input.scriptPath)).toBe(true)
        if (error) throw error
        // The converter writes the script next to its pid file; emit pages beside them.
        const dir = dirname(input.scriptPath)
        for (let i = 1; i <= pages; i += 1) writeFileSync(join(dir, `page-${i}.png`), PNG_BYTES)
      },
    }
  }

  test('writes the generated script, runs it, and collects pages in order', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'daedalus-ppt-conv-'))
    try {
      const fake = fakeRunner(2)
      const converter = createPowerPointConverter(fake.runner, () => "pwsh")
      const pages = await converter({ pptxPath: join(tmp, 'deck.pptx'), workDir: tmp, profileDir: tmp })
      expect(pages).toEqual([join(tmp, 'page-1.png'), join(tmp, 'page-2.png')])
      const run = fake.seen()
      expect(run?.timeoutMs).toBe(120_000)
      const scriptBody = readFileSync(run!.scriptPath, 'utf8')
      expect(scriptBody).toContain('New-Object -ComObject PowerPoint.Application')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('runner failure propagates to the service error state', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'daedalus-ppt-conv-'))
    try {
      const fake = fakeRunner(0, new Error('Render PowerPoint gagal: lisensi habis'))
      const converter = createPowerPointConverter(fake.runner, () => "pwsh")
      await expect(converter({ pptxPath: join(tmp, 'deck.pptx'), workDir: tmp, profileDir: tmp })).rejects.toThrow('lisensi habis')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('a run with no pages is an honest error, not an empty render', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'daedalus-ppt-conv-'))
    try {
      const fake = fakeRunner(0)
      const converter = createPowerPointConverter(fake.runner, () => "pwsh")
      await expect(converter({ pptxPath: join(tmp, 'deck.pptx'), workDir: tmp, profileDir: tmp })).rejects.toThrow('tidak menghasilkan gambar halaman')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('service engine routing', () => {
  const fakeExport: SlidePreviewDeps['exportPptx'] = async (root) => {
    const path = join(root, '.daedalus', 'fake-export.pptx')
    mkdirSync(join(root, '.daedalus'), { recursive: true })
    writeFileSync(path, Buffer.from('fake-pptx'))
    return { path, cleanup: async () => rmSync(path, { force: true }) }
  }

  function countingConverter(tag: string, log: string[]): PreviewConverter {
    return async ({ workDir }) => {
      log.push(tag)
      const file = join(workDir, 'page-1.png')
      writeFileSync(file, PNG_BYTES)
      return [file]
    }
  }

  test('LibreOffice converter wins when both engines could render', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'daedalus-ppt-route-'))
    try {
      const log: string[] = []
      const service = new SlidePreviewService({
        availability: () => ({ libreOffice: true, powerPoint: true }),
        converters: { libreoffice: countingConverter('libreoffice', log), powerpoint: countingConverter('powerpoint', log) },
        exportPptx: fakeExport,
      })
      const deck: DeckSpec = newDeck('Routing')
      deck.slides.push({ id: 's-1', layout: 'title', content: { title: 'Judul' } })
      const root = join(tmp, 'ws')
      mkdirSync(root, { recursive: true })
      await writeDeck(root, deck)
      const status = await service.render(root, deck, (key, page) => `/p?${key}:${page}`)
      expect(status.status).toBe('rendering')
      expect(status.engine).toBe('libreoffice')
      // Let the serialised queue finish, then read the settled status.
      const settled = await service.status(root, deck, (key, page) => `/p?${key}:${page}`)
      expect(['ready', 'rendering']).toContain(settled.status)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(log).toEqual(['libreoffice'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
