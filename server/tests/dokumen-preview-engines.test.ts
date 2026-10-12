import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import {
  buildWordExportScript,
  detectDocPreviewEngines,
  resolveDocPreviewEngine,
  type DocPreviewEngineSeams,
} from '../src/dokumen-preview.ts'
import { executableCandidates, findExecutableOnPath } from '../src/slide-preview.ts'

/**
 * Dokumen Pratinjau engine layer: Word via COM on Windows, else
 * LibreOffice. Everything here runs on Linux: platform, PATH and the
 * COM probe are injected seams, so the suite is deterministic without
 * Windows or Word. The generated Word script is asserted as TEXT
 * ONLY — it is never executed here; its first live run happens on a
 * real Windows machine.
 */

function hasFiles(...paths: string[]): DocPreviewEngineSeams['fileExists'] {
  const set = new Set(paths)
  return (path) => set.has(path)
}

describe('executable resolution (shared with Pratinjau Asli)', () => {
  test('windows candidates carry .exe variants; posix stays bare', () => {
    expect(executableCandidates('soffice', 'win32')).toEqual(['soffice.exe', 'soffice.com', 'soffice'])
    expect(executableCandidates('pdftoppm', 'win32')).toEqual(['pdftoppm.exe', 'pdftoppm'])
    expect(executableCandidates('soffice', 'linux')).toEqual(['soffice'])
  })

  test('findExecutableOnPath returns the full path of the first existing candidate', () => {
    const posix = findExecutableOnPath(['soffice'], {
      platform: 'linux',
      env: { PATH: '/usr/bin:/opt/lo/bin' },
      fileExists: hasFiles('/opt/lo/bin/soffice'),
    })
    expect(posix).toBe('/opt/lo/bin/soffice')
    expect(findExecutableOnPath(['soffice'], { platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: hasFiles() })).toBeNull()
  })
})

describe('engine detection + selection', () => {
  const loFiles = ['/usr/bin/soffice', '/usr/bin/pdftoppm']

  test('posix with soffice+pdftoppm -> LibreOffice engine', async () => {
    const availability = await detectDocPreviewEngines({ platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: hasFiles(...loFiles) })
    expect(availability).toEqual({ libreOffice: true, word: false })
    expect(resolveDocPreviewEngine(availability)).toBe('libreoffice')
  })

  test('LibreOffice needs BOTH soffice and pdftoppm', async () => {
    const availability = await detectDocPreviewEngines({ platform: 'linux', env: { PATH: '/usr/bin' }, fileExists: hasFiles('/usr/bin/soffice') })
    expect(availability.libreOffice).toBe(false)
    expect(resolveDocPreviewEngine(availability)).toBeNull()
  })

  test('win32 PREFERS Word when both engines are available (Farid directive)', async () => {
    const ps = join('C:\\ps', 'powershell.exe')
    const availability = await detectDocPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\lo\\program;C:\\ps;C:\\poppler' },
      fileExists: hasFiles(join('C:\\lo\\program', 'soffice.exe'), join('C:\\poppler', 'pdftoppm.exe'), ps),
      probeWordCom: async () => true,
    })
    expect(availability).toEqual({ libreOffice: true, word: true })
    expect(resolveDocPreviewEngine(availability)).toBe('word')
  })

  test('win32 without LibreOffice but with Word COM -> Word engine', async () => {
    const availability = await detectDocPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\ps;C:\\poppler' },
      fileExists: hasFiles(join('C:\\ps', 'powershell.exe'), join('C:\\poppler', 'pdftoppm.exe')),
      probeWordCom: async () => true,
    })
    expect(availability).toEqual({ libreOffice: false, word: true })
    expect(resolveDocPreviewEngine(availability)).toBe('word')
  })

  test('win32 falls back to LibreOffice when Word COM is absent', async () => {
    const availability = await detectDocPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\lo\\program;C:\\ps;C:\\poppler' },
      fileExists: hasFiles(join('C:\\lo\\program', 'soffice.exe'), join('C:\\poppler', 'pdftoppm.exe'), join('C:\\ps', 'powershell.exe')),
      probeWordCom: async () => false,
    })
    expect(availability).toEqual({ libreOffice: true, word: false })
    expect(resolveDocPreviewEngine(availability)).toBe('libreoffice')
  })

  test('win32 Word requires pdftoppm alongside PowerShell + COM', async () => {
    const availability = await detectDocPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\ps' },
      fileExists: hasFiles(join('C:\\ps', 'powershell.exe')),
      probeWordCom: async () => true,
    })
    expect(availability.word).toBe(false)
    expect(availability.libreOffice).toBe(false)
    expect(resolveDocPreviewEngine(availability)).toBeNull()
  })

  test('a failing Word COM probe reads as not-available, never a rejection', async () => {
    const availability = await detectDocPreviewEngines({
      platform: 'win32',
      env: { PATH: 'C:\\ps;C:\\poppler' },
      fileExists: hasFiles(join('C:\\ps', 'powershell.exe'), join('C:\\poppler', 'pdftoppm.exe')),
      probeWordCom: async () => {
        throw new Error('probe exploded')
      },
    })
    expect(availability.word).toBe(false)
  })

  test('Word is never probed off Windows, even with pwsh present', async () => {
    let probes = 0
    const availability = await detectDocPreviewEngines({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      fileExists: hasFiles('/usr/bin/pwsh', '/usr/bin/pdftoppm'),
      probeWordCom: async () => {
        probes += 1
        return true
      },
    })
    expect(availability.word).toBe(false)
    expect(probes).toBe(0)
  })
})

describe('Word COM script generation (TEXT ONLY — never executed here)', () => {
  const script = buildWordExportScript({
    docxPath: "C:\\docs\\it's a draft.docx",
    pdfPath: 'C:\\out\\preview.pdf',
    pidFile: 'C:\\out\\started-pids.txt',
  })

  test('opens the DOCX read-only (ConfirmConversions/ReadOnly/AddToRecentFiles=false)', () => {
    expect(script).toContain('$document = $word.Documents.Open($docxPath, $false, $true, $false)')
  })

  test('exports the whole document to PDF via ExportAsFixedFormat format 17', () => {
    expect(script).toContain('$document.ExportAsFixedFormat($pdfPath, 17)')
    expect(script).not.toContain('SaveAs')
    expect(script).not.toContain('SaveAs2')
  })

  test('closes without saving', () => {
    expect(script).toContain('$document.Close($false)')
    expect(script).not.toContain('Close($true)')
  })

  test('snapshots WINWORD pids, records self-started ones, and quits only when none pre-existed', () => {
    expect(script).toContain("Get-Process -Name WINWORD")
    expect(script).toContain('$startedByUs = @(Get-WordPids | Where-Object { $preExisting -notcontains $_ })')
    expect(script).toContain('[IO.File]::WriteAllLines($pidFile, [string[]]$startedByUs)')
    expect(script).toContain('if ($preExisting.Count -eq 0)')
    expect(script).toContain('$word.Quit()')
    // Quit must be AFTER the close, and guarded by the emptiness check.
    const closeIdx = script.indexOf('$document.Close($false)')
    const quitIdx = script.indexOf('$word.Quit()')
    expect(closeIdx).toBeGreaterThan(-1)
    expect(quitIdx).toBeGreaterThan(closeIdx)
    expect(script.indexOf('if ($preExisting.Count -eq 0)')).toBeLessThan(quitIdx)
  })

  test('errors reach stderr with exit 1, so a failure can never look like success', () => {
    expect(script).toContain('[Console]::Error.WriteLine')
    expect(script).toContain('exit 1')
  })

  test('paths are single-quote escaped (apostrophes doubled) and Word stays invisible', () => {
    expect(script).toContain("$docxPath = 'C:\\docs\\it''s a draft.docx'")
    expect(script).toContain('$word.Visible = $false')
    expect(script).toContain('$word.DisplayAlerts = 0')
    expect(script).toContain("New-Object -ComObject Word.Application")
  })
})
