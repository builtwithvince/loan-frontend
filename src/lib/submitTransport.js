/**
 * Sends a loan application and reports, truthfully, how far it got.
 *
 * Why this exists: the forms used to POST with fetch under one 90-second
 * timer that also covered the upload. On a slow phone connection the timer
 * fired mid-upload and the form said "it may still have gone through — don't
 * submit again". It hadn't: the backend saves nothing until the whole upload
 * has arrived (Ondillo Group, 2026-11-15: 66MB, aborted at 90s, no row). fetch
 * can't see upload progress, so it can't tell those two cases apart. XHR can.
 *
 * The rule this module enforces:
 * - Cut off before the upload finished → nothing was saved → safe to retry.
 * - Upload finished but no answer → the backend may have saved it → don't
 *   retry (duplicate-application risk), show "pending confirmation".
 */

import { compressFormDataImages } from './compressImages'
import { summarizeAttachments } from './submitErrors'

// No upload progress for this long = the connection is dead, not slow.
const STALL_MS = 60_000
// Once the upload is done, how long to wait for the backend's answer. Same
// budget the old whole-request timer had, now spent on processing alone.
const RESPONSE_MS = 90_000

/**
 * A submit that ended without an HTTP status.
 * `phase` is what matters: 'upload' means the backend never got the whole
 * request (nothing saved, safe to retry); 'response' means it did and may
 * have saved it (do not retry).
 */
export class SubmitTransportError extends Error {
  /**
   * @param {'upload'|'response'} phase
   * @param {'stalled'|'timeout'|'network'} reason
   */
  constructor(phase, reason) {
    super(`Submit ${reason} during ${phase}`)
    this.name = 'SubmitTransportError'
    this.phase = phase
    this.reason = reason
  }
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * POST a FormData with upload progress, a stall timer during the upload and a
 * response timer after it.
 * @param {object} args
 * @param {string} args.url
 * @param {FormData} args.formData
 * @param {Record<string,string>} [args.headers]
 * @param {(fraction: number) => void} [args.onUploadProgress] 0..1
 * @param {() => void} [args.onUploadDone]
 * @param {{stallMs?: number, responseMs?: number}} [args.timeouts] Tests only.
 * @returns {Promise<{status: number, ok: boolean, data: object|null}>}
 *   Resolves on any HTTP status (data null when the body is unreadable).
 *   Rejects with SubmitTransportError when no status ever arrived.
 */
export function sendApplication({
  url,
  formData,
  headers = {},
  onUploadProgress,
  onUploadDone,
  timeouts = {},
}) {
  const stallMs = timeouts.stallMs ?? STALL_MS
  const responseMs = timeouts.responseMs ?? RESPONSE_MS

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let uploadDone = false
    let abortReason = null
    let seenStatus = 0
    let timer = null

    const arm = (ms, reason) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        abortReason = reason
        xhr.abort()
      }, ms)
    }
    const finish = () => clearTimeout(timer)
    const phase = () => (uploadDone ? 'response' : 'upload')

    xhr.upload.onprogress = e => {
      if (!uploadDone) arm(stallMs, 'stalled')
      if (e.lengthComputable && e.total > 0) onUploadProgress?.(e.loaded / e.total)
    }
    xhr.upload.onload = () => {
      uploadDone = true
      onUploadDone?.()
      arm(responseMs, 'timeout')
    }
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= 2 && xhr.status) seenStatus = xhr.status
    }
    xhr.onload = () => {
      finish()
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        data: parseJson(xhr.responseText),
      })
    }
    const fail = reason => {
      finish()
      // The backend answered (headers arrived) and then the connection broke,
      // e.g. the access-code gate or the upload limit replying mid-upload.
      // Hand back the status like fetch would, with the body unread.
      if (seenStatus) {
        resolve({ status: seenStatus, ok: seenStatus >= 200 && seenStatus < 300, data: null })
        return
      }
      reject(new SubmitTransportError(phase(), reason))
    }
    xhr.onerror = () => fail('network')
    xhr.onabort = () => fail(abortReason || 'network')

    xhr.open('POST', url)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    arm(stallMs, 'stalled')
    xhr.send(formData)
  })
}

/**
 * Compress the photos, then send. The one call the five loan forms make.
 * @param {object} args
 * @param {string} args.url
 * @param {FormData} args.formData Built by the form, photos at full size.
 * @param {Record<string,string>} [args.headers]
 * @param {(label: string) => void} [args.onStatus] Text for the submit button.
 * @returns {Promise<{res: {status:number, ok:boolean, data:object|null}, attachments: ReturnType<typeof summarizeAttachments>}>}
 *   Rejects with SubmitTransportError (see sendApplication).
 */
export async function submitApplication({ url, formData, headers, onStatus }) {
  onStatus?.('Preparing documents…')
  const compressed = await compressFormDataImages(formData, (done, total) =>
    onStatus?.(`Preparing documents (${done}/${total})…`),
  )
  // Summarise what is actually sent, so an upload rejection names a real size.
  const attachments = summarizeAttachments(compressed)
  onStatus?.('Uploading…')
  const res = await sendApplication({
    url,
    formData: compressed,
    headers,
    onUploadProgress: f => onStatus?.(`Uploading… ${Math.floor(f * 100)}%`),
    onUploadDone: () => onStatus?.('Confirming…'),
  })
  return { res, attachments }
}
