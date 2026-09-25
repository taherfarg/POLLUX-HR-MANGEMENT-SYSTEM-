import { apiBlob } from '../api/client.js'

/**
 * Files behind authentication cannot be plain links - the browser would not
 * send the bearer token. They are fetched with it and handed to the browser
 * as a temporary object URL instead.
 */

/** Saves a file from the API under the name the server suggested. */
export async function downloadFile(path, params) {
  const { blob, fileName } = await apiBlob(path, { params })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return fileName
}

/**
 * Opens a file (a payslip PDF) in a new tab. The tab is opened before the
 * request so popup blockers treat it as the user's click; if that fails the
 * file is downloaded instead.
 */
export async function openFile(path, params) {
  const tab = window.open('', '_blank')
  try {
    const { blob } = await apiBlob(path, { params })
    const url = URL.createObjectURL(blob)
    if (tab) {
      tab.location.href = url
    } else {
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener'
      link.click()
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 120_000)
  } catch (error) {
    tab?.close()
    throw error
  }
}
