import {
  ConfirmedSlidePrompt,
  DeckOutline,
  GenerationConfig,
  ProjectRecord,
  Slide,
  WorkflowState
} from '../types'

export const TEST_PROJECT_DB_NAME = 'aippt_projects'
export const TEST_PROJECT_STORE_NAME = 'projects'
export const TEST_ASSET_STORE_NAME = 'assets'

export interface StoredProjectAsset {
  key: string
  projectId: string
  bucket: 'slides' | 'lastCompletedSlides'
  slideId: string
  mimeType: string
  bytes: ArrayBuffer
  imageBase64: string
  byteLength: number
  updatedAt: number
}

interface RawStoredProjectAsset extends Omit<StoredProjectAsset, 'imageBase64'> {}

export const TEST_GENERATION_CONFIG: GenerationConfig = {
  pageCount: 1,
  quality: '1K',
  aspectRatio: '16:9',
  language: '中文',
  style: '现代简约商务风格',
  targetAudience: '专业人士',
  userRequirements: ''
}

export const EMPTY_WORKFLOW_STATE: WorkflowState = {
  status: 'idle',
  outline: null,
  slidePrompts: [],
  expandedOutlinePages: [],
  expandedDesignPages: [],
  error: null
}

export function buildDeckOutline(overrides: Partial<DeckOutline> = {}): DeckOutline {
  return {
    title: 'Demo deck',
    user_requirements: 'Make it concise',
    design_style: 'Modern',
    audience: 'Sales',
    slides: [{
      page: 1,
      title: 'Cover',
      narrative_goal: 'Introduce the deck',
      key_points: ['L9'],
      visual_direction: 'Dark vehicle hero'
    }],
    ...overrides
  }
}

export function buildSlidePrompt(overrides: Partial<ConfirmedSlidePrompt> = {}): ConfirmedSlidePrompt {
  return {
    page: 1,
    title: 'Cover',
    content_summary: 'A cover page',
    display_content: 'A cover page',
    prompt: 'Generate a cover page',
    ...overrides
  }
}

export function buildSlide(overrides: Partial<Slide> = {}): Slide {
  return {
    id: 'slide-1',
    pageNumber: 1,
    imageUrl: 'data:image/png;base64,aaa',
    imageBase64: 'aaa',
    prompt: 'Generate a cover page',
    ...overrides
  }
}

function cloneSlide(slide: Slide): Slide {
  return {
    ...slide,
    ...(slide.imageAsset ? { imageAsset: { ...slide.imageAsset } } : {}),
    ...(slide.editHistory ? { editHistory: slide.editHistory.map((item) => ({ ...item })) } : {})
  }
}

export function buildProjectRecord(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  const now = 1712131200000
  const slides = overrides.slides ?? [buildSlide()]

  return {
    version: 2,
    id: overrides.id || 'project-1',
    title: overrides.title || 'Demo deck',
    fileName: overrides.fileName || 'L9.md',
    fileContent: overrides.fileContent || '# L9',
    slides,
    generationConfig: overrides.generationConfig || TEST_GENERATION_CONFIG,
    workflow: overrides.workflow || EMPTY_WORKFLOW_STATE,
    status: overrides.status || 'generated',
    generationRunId: overrides.generationRunId ?? null,
    lastCompletedSlides: overrides.lastCompletedSlides || slides.map(cloneSlide),
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    lastOpenedAt: overrides.lastOpenedAt || now
  }
}

export async function resetProjectStoreForTests(): Promise<void> {
  localStorage.clear()

  if (typeof indexedDB === 'undefined') {
    return
  }

  await deleteIndexedDb(TEST_PROJECT_DB_NAME)
}

function deleteIndexedDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error || new Error(`Failed to delete ${name}`))
    request.onblocked = () => reject(new Error(`Blocked while deleting ${name}`))
  })
}

export async function readStoredProject(id: string): Promise<ProjectRecord | null> {
  const db = await openTestProjectDb()
  try {
    return await requestToPromise<ProjectRecord | undefined>(
      db.transaction(TEST_PROJECT_STORE_NAME, 'readonly').objectStore(TEST_PROJECT_STORE_NAME).get(id)
    ) ?? null
  } finally {
    db.close()
  }
}

export async function readStoredAsset(key: string): Promise<StoredProjectAsset | null> {
  const db = await openTestProjectDb()
  try {
    const asset = await requestToPromise<RawStoredProjectAsset | undefined>(
      db.transaction(TEST_ASSET_STORE_NAME, 'readonly').objectStore(TEST_ASSET_STORE_NAME).get(key)
    )
    return asset ? normalizeStoredAsset(asset) : null
  } finally {
    db.close()
  }
}

export async function deleteStoredAsset(key: string): Promise<void> {
  const db = await openTestProjectDb()
  try {
    await waitForTransaction((transaction) => {
      transaction.objectStore(TEST_ASSET_STORE_NAME).delete(key)
    }, db.transaction(TEST_ASSET_STORE_NAME, 'readwrite'))
  } finally {
    db.close()
  }
}

export async function listStoredAssets(projectId: string): Promise<StoredProjectAsset[]> {
  const db = await openTestProjectDb()
  try {
    const transaction = db.transaction(TEST_ASSET_STORE_NAME, 'readonly')
    const index = transaction.objectStore(TEST_ASSET_STORE_NAME).index('projectId')
    const assets = await requestToPromise<RawStoredProjectAsset[]>(index.getAll(projectId))
    return assets.map(normalizeStoredAsset)
  } finally {
    db.close()
  }
}

function openTestProjectDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(TEST_PROJECT_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(TEST_PROJECT_STORE_NAME)) {
        const projectStore = db.createObjectStore(TEST_PROJECT_STORE_NAME, { keyPath: 'id' })
        projectStore.createIndex('updatedAt', 'updatedAt')
        projectStore.createIndex('lastOpenedAt', 'lastOpenedAt')
      }
      if (!db.objectStoreNames.contains(TEST_ASSET_STORE_NAME)) {
        const assetStore = db.createObjectStore(TEST_ASSET_STORE_NAME, { keyPath: 'key' })
        assetStore.createIndex('projectId', 'projectId')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error(`Failed to open ${TEST_PROJECT_DB_NAME}`))
  })
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'))
  })
}

function waitForTransaction(run: (transaction: IDBTransaction) => void, transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'))
    run(transaction)
  })
}

function normalizeStoredAsset(asset: RawStoredProjectAsset): StoredProjectAsset {
  return {
    ...asset,
    imageBase64: arrayBufferToBase64(asset.bytes)
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index])
  }
  return btoa(binary)
}
