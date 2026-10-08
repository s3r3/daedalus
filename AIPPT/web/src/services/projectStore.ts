import type { EditHistoryItem, ProjectRecord, ProjectSummary, Slide, SlideAssetRef } from '../types'

const DB_NAME = 'aippt_projects'
const DB_VERSION = 1
const PROJECT_STORE = 'projects'
const ASSET_STORE = 'assets'
const ACTIVE_PROJECT_ID_KEY = 'aippt_active_project_id'
const DEFAULT_IMAGE_MIME_TYPE = 'image/png'
const COMPACT_ASSET_URL_PREFIX = 'asset:'
const BASE64_CONVERSION_CHUNK_SIZE = 0x8000

type SlideBucket = 'slides' | 'lastCompletedSlides'

interface ProjectAssetRecord {
  key: string
  projectId: string
  bucket: SlideBucket
  slideId: string
  mimeType: string
  bytes: ArrayBuffer
  byteLength: number
  updatedAt: number
}

interface SlideImagePayload {
  base64: string
  mimeType: string
}

type EditHistoryItemWithAssetKey = EditHistoryItem & {
  imageStorageKey?: string
}

interface CompactedSlides {
  slides: Slide[]
  assets: ProjectAssetRecord[]
}

interface SaveProjectRecordOptions {
  allowMissingAssets?: boolean
}

export function createProjectId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }

  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function saveProjectRecord(
  project: ProjectRecord,
  options: SaveProjectRecordOptions = {}
): Promise<ProjectRecord> {
  const db = await openDb()
  try {
    const timestamp = Date.now()
    const compactedSlides = compactSlides(project.id, 'slides', project.slides, timestamp)
    const compactedCompletedSlides = compactSlides(
      project.id,
      'lastCompletedSlides',
      project.lastCompletedSlides,
      timestamp
    )
    const pendingAssets = [...compactedSlides.assets, ...compactedCompletedSlides.assets]

    const compactProject: ProjectRecord = {
      ...project,
      slides: compactedSlides.slides,
      lastCompletedSlides: compactedCompletedSlides.slides
    }
    return await saveCompactedProjectInTransaction(db, compactProject, pendingAssets, options)
  } finally {
    db.close()
  }
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const db = await openDb()
  try {
    const transaction = db.transaction(PROJECT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const project = await requestToPromise<ProjectRecord | undefined>(
      transaction.objectStore(PROJECT_STORE).get(id)
    )
    await done
    return project ?? null
  } finally {
    db.close()
  }
}

export async function getProjectSummaries(): Promise<ProjectSummary[]> {
  const db = await openDb()
  try {
    const transaction = db.transaction(PROJECT_STORE, 'readonly')
    const done = transactionDone(transaction)
    const projects = await requestToPromise<ProjectRecord[]>(
      transaction.objectStore(PROJECT_STORE).getAll()
    )
    await done
    return projects
      .map(createProjectSummary)
      .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt)
  } finally {
    db.close()
  }
}

export async function hydrateProjectImages(project: ProjectRecord): Promise<ProjectRecord> {
  const db = await openDb()
  try {
    const assetMap = await loadAssetMap(db, collectAssetKeys(project))
    return {
      ...project,
      slides: hydrateSlidesSync(project.slides, assetMap),
      lastCompletedSlides: hydrateSlidesSync(project.lastCompletedSlides, assetMap)
    }
  } finally {
    db.close()
  }
}

export async function verifyProjectIntegrity(
  project: ProjectRecord
): Promise<{ ok: boolean; missingAssetKeys: string[] }> {
  const db = await openDb()
  try {
    const assetKeys = collectAssetKeys(project)
    const assetMap = await loadAssetMap(db, assetKeys)
    const missingAssetKeys = assetKeys.filter((key) => !assetMap.has(key))

    return {
      ok: missingAssetKeys.length === 0,
      missingAssetKeys
    }
  } finally {
    db.close()
  }
}

export async function renameProject(id: string, title: string): Promise<ProjectRecord> {
  const project = await getRequiredProject(id)
  return saveProjectRecord({
    ...project,
    title,
    updatedAt: Date.now()
  })
}

export async function duplicateProject(id: string): Promise<ProjectRecord> {
  const source = await getRequiredProject(id)
  const hydratedSource = await hydrateProjectImages(source)
  const now = Date.now()

  return saveProjectRecord({
    ...hydratedSource,
    id: createProjectId(),
    title: `${source.title} copy`,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  })
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb()
  try {
    await deleteProjectAndAssets(db, id)
  } finally {
    db.close()
  }

  if (await getActiveProjectId() === id) {
    await clearActiveProjectId()
  }
}

export async function setActiveProjectId(id: string): Promise<void> {
  localStorage.setItem(ACTIVE_PROJECT_ID_KEY, id)
}

export async function getActiveProjectId(): Promise<string | null> {
  return localStorage.getItem(ACTIVE_PROJECT_ID_KEY)
}

export async function clearActiveProjectId(): Promise<void> {
  localStorage.removeItem(ACTIVE_PROJECT_ID_KEY)
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'))
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        const projectStore = db.createObjectStore(PROJECT_STORE, { keyPath: 'id' })
        projectStore.createIndex('updatedAt', 'updatedAt')
        projectStore.createIndex('lastOpenedAt', 'lastOpenedAt')
      } else {
        const projectStore = request.transaction?.objectStore(PROJECT_STORE)
        if (projectStore && !projectStore.indexNames.contains('updatedAt')) {
          projectStore.createIndex('updatedAt', 'updatedAt')
        }
        if (projectStore && !projectStore.indexNames.contains('lastOpenedAt')) {
          projectStore.createIndex('lastOpenedAt', 'lastOpenedAt')
        }
      }

      if (!db.objectStoreNames.contains(ASSET_STORE)) {
        const assetStore = db.createObjectStore(ASSET_STORE, { keyPath: 'key' })
        assetStore.createIndex('projectId', 'projectId')
      } else {
        const assetStore = request.transaction?.objectStore(ASSET_STORE)
        if (assetStore && !assetStore.indexNames.contains('projectId')) {
          assetStore.createIndex('projectId', 'projectId')
        }
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Failed to open project database'))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'))
  })
}

function compactSlides(
  projectId: string,
  bucket: SlideBucket,
  slides: Slide[],
  updatedAt: number
): CompactedSlides {
  const assets: ProjectAssetRecord[] = []
  const compactedSlides = slides.map((slide) => {
    const image = extractSlideImage(slide)
    const compactedHistory = compactEditHistory(projectId, bucket, slide, updatedAt)
    const compactSlide: Slide = {
      ...cloneSlideWithoutBase64(slide),
      ...(slide.editHistory ? { editHistory: compactedHistory.editHistory } : {})
    }
    assets.push(...compactedHistory.assets)

    if (!image) {
      const referenceKey = getSlideAssetKey(slide)
      if (referenceKey) {
        return {
          ...compactSlide,
          imageUrl: '',
          imageStorageKey: referenceKey
        }
      }
      return compactSlide
    }

    const existingAssetKey = getSlideAssetKey(slide)
    const defaultAssetKey = createSlideAssetKey(projectId, bucket, slide.id)
    const key = existingAssetKey === defaultAssetKey ? existingAssetKey : defaultAssetKey
    const bytes = base64ToArrayBuffer(image.base64)
    const asset: ProjectAssetRecord = {
      key,
      projectId,
      bucket,
      slideId: slide.id,
      mimeType: image.mimeType,
      bytes,
      byteLength: bytes.byteLength,
      updatedAt
    }
    assets.push(asset)

    return {
      ...compactSlide,
      imageUrl: '',
      imageStorageKey: key,
      imageAsset: createSlideAssetRef(asset)
    }
  })

  return {
    slides: compactedSlides,
    assets
  }
}

function extractSlideImage(slide: Slide): SlideImagePayload | null {
  const dataUrlImage = extractDataUrlImage(slide.imageUrl)

  if (slide.imageBase64) {
    return {
      base64: slide.imageBase64,
      mimeType: dataUrlImage?.mimeType || slide.imageAsset?.mimeType || DEFAULT_IMAGE_MIME_TYPE
    }
  }

  return dataUrlImage
}

function compactEditHistory(
  projectId: string,
  bucket: SlideBucket,
  slide: Slide,
  updatedAt: number
): { editHistory: EditHistoryItem[]; assets: ProjectAssetRecord[] } {
  if (!slide.editHistory) {
    return {
      editHistory: [],
      assets: []
    }
  }

  const assets: ProjectAssetRecord[] = []
  const editHistory = slide.editHistory.map((item, index) => {
    const image = extractEditHistoryImage(item)
    const existingAssetKey = getEditHistoryAssetKey(item)
    const baseItem = cloneEditHistoryItemWithoutAssetKey(item)

    if (!image) {
      return existingAssetKey
        ? {
          ...baseItem,
          imageUrl: `${COMPACT_ASSET_URL_PREFIX}${existingAssetKey}`,
          imageBase64: ''
        }
        : { ...baseItem }
    }

    const defaultAssetKey = createEditHistoryAssetKey(projectId, bucket, slide.id, index, item.timestamp)
    const key = existingAssetKey === defaultAssetKey ? existingAssetKey : defaultAssetKey
    const bytes = base64ToArrayBuffer(image.base64)
    assets.push({
      key,
      projectId,
      bucket,
      slideId: slide.id,
      mimeType: image.mimeType,
      bytes,
      byteLength: bytes.byteLength,
      updatedAt
    })

    return {
      ...baseItem,
      imageUrl: `${COMPACT_ASSET_URL_PREFIX}${key}`,
      imageBase64: ''
    }
  })

  return {
    editHistory,
    assets
  }
}

function extractEditHistoryImage(item: EditHistoryItem): SlideImagePayload | null {
  const dataUrlImage = extractDataUrlImage(item.imageUrl)

  if (item.imageBase64) {
    return {
      base64: item.imageBase64,
      mimeType: dataUrlImage?.mimeType || DEFAULT_IMAGE_MIME_TYPE
    }
  }

  return dataUrlImage
}

function extractDataUrlImage(imageUrl: string): SlideImagePayload | null {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(imageUrl)
  if (!match?.[2]) {
    return null
  }

  return {
    mimeType: match[1] || DEFAULT_IMAGE_MIME_TYPE,
    base64: match[2]
  }
}

function cloneSlideWithoutBase64(slide: Slide): Slide {
  const clone = cloneSlide(slide)
  delete clone.imageBase64
  return clone
}

function cloneSlide(slide: Slide): Slide {
  return {
    ...slide,
    ...(slide.imageAsset ? { imageAsset: { ...slide.imageAsset } } : {}),
    ...(slide.editHistory ? { editHistory: slide.editHistory.map((item) => ({ ...item })) } : {})
  }
}

function createSlideAssetKey(projectId: string, bucket: SlideBucket, slideId: string): string {
  return `${projectId}:${bucket}:${slideId}:current`
}

function createEditHistoryAssetKey(
  projectId: string,
  bucket: SlideBucket,
  slideId: string,
  historyIndex: number,
  timestamp: number
): string {
  return `${projectId}:${bucket}:${slideId}:editHistory:${historyIndex}:${timestamp}`
}

function getSlideAssetKey(slide: Slide): string | null {
  return slide.imageStorageKey || slide.imageAsset?.key || null
}

function getEditHistoryAssetKey(item: EditHistoryItem): string | null {
  const hydratedAssetKey = (item as EditHistoryItemWithAssetKey).imageStorageKey
  if (hydratedAssetKey) {
    return hydratedAssetKey
  }

  return item.imageUrl.startsWith(COMPACT_ASSET_URL_PREFIX)
    ? item.imageUrl.slice(COMPACT_ASSET_URL_PREFIX.length)
    : null
}

function cloneEditHistoryItemWithoutAssetKey(item: EditHistoryItem): EditHistoryItem {
  const clone = { ...item } as EditHistoryItemWithAssetKey
  delete clone.imageStorageKey
  return clone
}

function attachEditHistoryAssetKey(item: EditHistoryItem, key: string): EditHistoryItem {
  Object.defineProperty(item, 'imageStorageKey', {
    value: key,
    enumerable: false,
    configurable: true,
    writable: true
  })
  return item
}

function createSlideAssetRef(asset: ProjectAssetRecord): SlideAssetRef {
  return {
    key: asset.key,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength
  }
}

async function saveCompactedProjectInTransaction(
  db: IDBDatabase,
  project: ProjectRecord,
  assets: ProjectAssetRecord[],
  options: SaveProjectRecordOptions = {}
): Promise<ProjectRecord> {
  const transaction = db.transaction([PROJECT_STORE, ASSET_STORE], 'readwrite')
  const done = transactionDone(transaction)
  const assetStore = transaction.objectStore(ASSET_STORE)
  const projectStore = transaction.objectStore(PROJECT_STORE)
  const assetByKey = new Map(assets.map((asset) => [asset.key, asset]))

  try {
    const assetsToWrite = await resolvePendingAssets(assetStore, assets, assetByKey)
    assetsToWrite.forEach((asset) => assetStore.put(asset))
    await loadReferencedAssets(assetStore, project, assetByKey, options.allowMissingAssets === true)

    const normalizedProject: ProjectRecord = {
      ...project,
      slides: applyAssetMetadata(project.slides, assetByKey),
      lastCompletedSlides: applyAssetMetadata(project.lastCompletedSlides, assetByKey)
    }

    projectStore.put(normalizedProject)
    pruneUnreferencedProjectAssets(assetStore, normalizedProject)
    await done
    return normalizedProject
  } catch (error) {
    abortTransaction(transaction)
    await ignoreTransactionAbort(done)
    throw error
  }
}

async function resolvePendingAssets(
  assetStore: IDBObjectStore,
  assets: ProjectAssetRecord[],
  assetByKey: Map<string, ProjectAssetRecord>
): Promise<ProjectAssetRecord[]> {
  const comparedAssets = await Promise.all(assets.map(async (asset) => {
    const storedAsset = await requestToPromise<ProjectAssetRecord | undefined>(
      assetStore.get(asset.key)
    )

    if (storedAsset && hasSameAssetImage(storedAsset, asset)) {
      assetByKey.set(asset.key, storedAsset)
      return null
    }

    assetByKey.set(asset.key, asset)
    return asset
  }))

  return comparedAssets.filter((asset): asset is ProjectAssetRecord => asset !== null)
}

function hasSameAssetImage(left: ProjectAssetRecord, right: ProjectAssetRecord): boolean {
  if (
    left.mimeType !== right.mimeType ||
    left.byteLength !== right.byteLength ||
    left.bytes.byteLength !== right.bytes.byteLength
  ) {
    return false
  }

  const leftBytes = new Uint8Array(left.bytes)
  const rightBytes = new Uint8Array(right.bytes)
  for (let index = 0; index < leftBytes.length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return false
    }
  }

  return true
}

async function loadReferencedAssets(
  assetStore: IDBObjectStore,
  project: ProjectRecord,
  assetByKey: Map<string, ProjectAssetRecord>,
  allowMissingAssets: boolean
): Promise<void> {
  const missingKeys = collectAssetKeys(project).filter(key => !assetByKey.has(key))

  await Promise.all(missingKeys.map(async (key) => {
    const asset = await requestToPromise<ProjectAssetRecord | undefined>(assetStore.get(key))
    if (!asset) {
      if (allowMissingAssets) {
        return
      }
      throw new Error(`Missing image asset: ${key}`)
    }
    assetByKey.set(key, asset)
  }))
}

function pruneUnreferencedProjectAssets(assetStore: IDBObjectStore, project: ProjectRecord): void {
  const referencedAssetKeys = new Set(collectAssetKeys(project))
  const assetIndex = assetStore.index('projectId')
  const cursorRequest = assetIndex.openCursor(IDBKeyRange.only(project.id))

  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) {
      return
    }

    if (!referencedAssetKeys.has(cursor.primaryKey as string)) {
      cursor.delete()
    }
    cursor.continue()
  }
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort()
  } catch {
    // The transaction may already be inactive or aborted by IndexedDB.
  }
}

async function ignoreTransactionAbort(done: Promise<void>): Promise<void> {
  try {
    await done
  } catch {
    // Preserve the original validation or request error.
  }
}

function collectAssetKeys(project: ProjectRecord): string[] {
  const seen = new Set<string>()
  const keys: string[] = []

  for (const slide of [...project.slides, ...project.lastCompletedSlides]) {
    for (const key of getSlideReferencedAssetKeys(slide)) {
      if (!seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }

  return keys
}

function getSlideReferencedAssetKeys(slide: Slide): string[] {
  const keys: string[] = []
  const slideAssetKey = getSlideAssetKey(slide)

  if (slideAssetKey) {
    keys.push(slideAssetKey)
  }

  for (const item of slide.editHistory ?? []) {
    const historyAssetKey = getEditHistoryAssetKey(item)
    if (historyAssetKey) {
      keys.push(historyAssetKey)
    }
  }

  return keys
}

function applyAssetMetadata(slides: Slide[], assetByKey: Map<string, ProjectAssetRecord>): Slide[] {
  return slides.map((slide) => {
    const key = getSlideAssetKey(slide)
    const compactSlide = {
      ...cloneSlideWithoutBase64(slide),
      ...(slide.editHistory ? { editHistory: applyEditHistoryAssetMetadata(slide.editHistory, assetByKey) } : {})
    }

    if (!key) {
      return compactSlide
    }

    const asset = assetByKey.get(key)
    if (!asset) {
      return stripMissingSlideAssetRef(compactSlide)
    }

    return {
      ...compactSlide,
      imageUrl: '',
      imageStorageKey: key,
      imageAsset: createSlideAssetRef(asset)
    }
  })
}

function applyEditHistoryAssetMetadata(
  history: EditHistoryItem[],
  assetByKey: Map<string, ProjectAssetRecord>
): EditHistoryItem[] {
  return history.map((item) => {
    const key = getEditHistoryAssetKey(item)
    const baseItem = cloneEditHistoryItemWithoutAssetKey(item)

    if (!key) {
      return baseItem
    }

    if (!assetByKey.has(key)) {
      return {
        ...baseItem,
        imageUrl: '',
        imageBase64: ''
      }
    }

    return {
      ...baseItem,
      imageUrl: `${COMPACT_ASSET_URL_PREFIX}${key}`,
      imageBase64: ''
    }
  })
}

async function loadAssetMap(db: IDBDatabase, keys: string[]): Promise<Map<string, ProjectAssetRecord>> {
  const assetMap = new Map<string, ProjectAssetRecord>()
  if (keys.length === 0) {
    return assetMap
  }

  const transaction = db.transaction(ASSET_STORE, 'readonly')
  const done = transactionDone(transaction)
  try {
    const assetStore = transaction.objectStore(ASSET_STORE)
    const assets = await Promise.all(keys.map((key) => (
      requestToPromise<ProjectAssetRecord | undefined>(assetStore.get(key))
    )))
    await done
    keys.forEach((key, index) => {
      const asset = assets[index]
      if (asset) {
        assetMap.set(key, asset)
      }
    })
    return assetMap
  } catch (error) {
    abortTransaction(transaction)
    await ignoreTransactionAbort(done)
    throw error
  }
}

function stripMissingSlideAssetRef(slide: Slide): Slide {
  const cleanSlide = { ...slide }
  delete cleanSlide.imageStorageKey
  delete cleanSlide.imageAsset
  return {
    ...cleanSlide,
    imageUrl: ''
  }
}

function hydrateSlidesSync(slides: Slide[], assetMap: Map<string, ProjectAssetRecord>): Slide[] {
  return slides.map((slide) => {
    const key = getSlideAssetKey(slide)
    if (!key) {
      return hydrateEditHistorySync(cloneSlide(slide), assetMap)
    }

    const asset = assetMap.get(key)
    if (!asset) {
      return hydrateEditHistorySync(stripMissingSlideAssetRef(cloneSlideWithoutBase64(slide)), assetMap)
    }

    const imageBase64 = arrayBufferToBase64(asset.bytes)
    return hydrateEditHistorySync({
      ...cloneSlideWithoutBase64(slide),
      imageStorageKey: key,
      imageAsset: createSlideAssetRef(asset),
      imageBase64,
      imageUrl: `data:${asset.mimeType};base64,${imageBase64}`
    }, assetMap)
  })
}

function hydrateEditHistorySync(slide: Slide, assetMap: Map<string, ProjectAssetRecord>): Slide {
  if (!slide.editHistory) {
    return slide
  }

  const editHistory: EditHistoryItem[] = []
  for (const item of slide.editHistory) {
    const key = getEditHistoryAssetKey(item)
    if (!key) {
      editHistory.push({ ...item })
      continue
    }

    const asset = assetMap.get(key)
    if (!asset) {
      editHistory.push({
        ...cloneEditHistoryItemWithoutAssetKey(item),
        imageUrl: '',
        imageBase64: ''
      })
      continue
    }

    const imageBase64 = arrayBufferToBase64(asset.bytes)
    editHistory.push(attachEditHistoryAssetKey({
      ...item,
      imageUrl: `data:${asset.mimeType};base64,${imageBase64}`,
      imageBase64
    }, key))
  }

  return {
    ...slide,
    editHistory
  }
}

function createProjectSummary(project: ProjectRecord): ProjectSummary {
  return {
    id: project.id,
    title: project.title,
    fileName: project.fileName,
    slideCount: project.slides.length,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt
  }
}

async function getRequiredProject(id: string): Promise<ProjectRecord> {
  const project = await getProject(id)
  if (!project) {
    throw new Error(`Project not found: ${id}`)
  }
  return project
}

async function deleteProjectAndAssets(db: IDBDatabase, id: string): Promise<void> {
  const transaction = db.transaction([PROJECT_STORE, ASSET_STORE], 'readwrite')
  const done = transactionDone(transaction)
  transaction.objectStore(PROJECT_STORE).delete(id)

  const assetIndex = transaction.objectStore(ASSET_STORE).index('projectId')
  const cursorRequest = assetIndex.openCursor(IDBKeyRange.only(id))
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) {
      return
    }
    cursor.delete()
    cursor.continue()
  }

  await done
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes.buffer
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''

  for (let index = 0; index < bytes.length; index += BASE64_CONVERSION_CHUNK_SIZE) {
    const chunk = bytes.subarray(index, index + BASE64_CONVERSION_CHUNK_SIZE)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}
