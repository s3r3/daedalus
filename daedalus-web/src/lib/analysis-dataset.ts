import type { AnalysisDataset } from '../api/client'

export const DATASET_ACCEPT = '.csv,.xlsx'

/** True for file names the Analis mode can turn into an analysis dataset. */
export function isDatasetFileName(name: string): boolean {
  return /\.(csv|xlsx)$/i.test(name)
}

/** Read a picked file as an inline analysis dataset: CSV as text, XLSX as base64. */
export function readDatasetFile(file: File): Promise<AnalysisDataset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Gagal membaca ${file.name}`))
    if (file.name.toLowerCase().endsWith('.csv')) {
      reader.onload = () => resolve({ kind: 'csv', text: typeof reader.result === 'string' ? reader.result : '', name: file.name })
      reader.readAsText(file)
    } else {
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
        const base64 = dataUrl.includes(',') ? (dataUrl.split(',')[1] ?? '') : dataUrl
        resolve({ kind: 'xlsx', base64, name: file.name })
      }
      reader.readAsDataURL(file)
    }
  })
}
