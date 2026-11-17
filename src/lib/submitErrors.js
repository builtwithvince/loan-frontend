/**
 * Maps a failed public application submit into the result screen the 5 loan
 * forms render.
 *
 * Why this exists: the backend rejects oversized / over-count uploads at the
 * multer gate, BEFORE the route handler runs. It answers 400
 * `{ status:'error', message:'A file exceeds the NMB size limit.' }` — but the
 * browser cannot always READ that body. Multer replies while the browser is
 * still streaming the request, so Node resets the socket and `res.json()` /
 * `res.text()` throws on a truncated body. That is how three AKAP applications
 * on 2026-09-07 surfaced only "The server rejected the request (error 400).
 * Nothing was saved — please try again." The server did explain itself; the
 * client never got to read the explanation.
 *
 * So every branch here degrades gracefully: use the server's message when it
 * arrives, otherwise reconstruct a useful one from the status code plus what
 * the client already knows about the files it attached.
 */

// Mirror of the backend multer limits (loan-backend routes/application.js).
// [ASSUMPTION] These must be changed in lockstep with the backend. Drift here
// loses whole applications silently: the form accepts a file the server then
// rejects at the gate, before anything is saved.
export const MAX_UPLOAD_MB = 10
export const MAX_UPLOAD_FILES = 60
export const MAX_FILE_SIZE = MAX_UPLOAD_MB * 1024 * 1024

const SIZE_FIXES = [
  'Retake the photo with your camera set to a lower resolution, or crop it — phone camera photos are usually several times bigger than they need to be.',
  'Open the photo, take a screenshot of it, and upload the screenshot instead — screenshots are much smaller than the original photo.',
  'If you uploaded a scanned PDF, re-scan it at a lower quality or "compressed" setting.',
]

const COUNT_FIXES = [
  'Remove any duplicate uploads — one file per document.',
  'If a document has several pages, combine them into a single PDF before uploading.',
]

const PHONE_FIXES = [
  'Check all 11 digits of your mobile number — it must start with 09.',
  'Use a number registered in your own name that you actively use.',
  'A very new or rarely used SIM may not be verifiable yet. Try another number you own, or contact us for help.',
]

/** Human-readable size, e.g. 7.2 MB. */
export function formatFileSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Summarise the files attached to a FormData: how many, and the biggest one.
 * Used to make an unreadable upload rejection specific ("Your largest document
 * is IMG_2931.jpg at 7.2 MB") instead of generic.
 * @param {FormData} fd
 * @returns {{count: number, largest: {name: string, size: number}|null}}
 */
export function summarizeAttachments(fd) {
  let count = 0
  let largest = null
  for (const [, value] of fd.entries()) {
    if (!(value instanceof File)) continue
    count++
    if (!largest || value.size > largest.size) largest = { name: value.name, size: value.size }
  }
  return { count, largest }
}

function oversizeResult(serverMessage, attachments) {
  const largest = attachments?.largest
  const detail = largest
    ? ` Your largest document is ${largest.name} (${formatFileSize(largest.size)}).`
    : ''
  // Only state a limit when the server actually told us one. On the inferred
  // path we know the upload was refused but not the threshold it was refused
  // against, and naming a number the file is already under reads as nonsense.
  const lead =
    serverMessage || 'Your documents could not be uploaded — one of them is most likely too large.'
  return {
    status: 'error',
    title: 'A Document Is Too Large',
    message: `${lead}${detail} Nothing was saved — replace it with a smaller file and submit again.`,
    suggestions: SIZE_FIXES,
    actionLabel: 'Fix My Documents',
    refocusDocuments: true,
  }
}

function serverFaultResult(status) {
  return {
    status: 'error',
    title: 'Our Server Had a Problem',
    message: `Our server ran into a problem and could not finish your application (error ${status}). Nothing was saved.`,
    suggestions: [
      'Wait a minute, then submit again — this is usually temporary.',
      'If it keeps failing, contact us and quote the error number above. We can take your application over the phone.',
    ],
  }
}

function overcountResult(serverMessage) {
  return {
    status: 'error',
    title: 'Too Many Files',
    message: `${serverMessage || `This application has more than the ${MAX_UPLOAD_FILES} files we can accept at once.`} Nothing was saved — remove a few files and submit again.`,
    suggestions: COUNT_FIXES,
    actionLabel: 'Fix My Documents',
    refocusDocuments: true,
  }
}

/**
 * Build the result screen for a non-2xx submit response.
 * @param {object} args
 * @param {number} args.status HTTP status code
 * @param {object|null} args.data Parsed JSON body, or null if unreadable
 * @param {{count:number,largest:{name:string,size:number}|null}} args.attachments
 *   From summarizeAttachments — lets an unreadable rejection still name the
 *   likely culprit file.
 * @returns {{status:string,title:string,message:string,suggestions:string[],actionLabel?:string,refocusDocuments?:boolean}}
 */
export function buildHttpFailureResult({ status, data, attachments }) {
  const serverMessage = (data && (data.message || data.error)) || null
  const probe = (serverMessage || '').toLowerCase()

  // 413 comes from the proxy (Cloudflare / Railway) when the whole multipart
  // body is too big, never from the app — it has no JSON body to read.
  if (status === 413) return oversizeResult(null, attachments)

  // Narrow enough not to swallow an unrelated "exceeds" message (loan amount,
  // term) that should be shown verbatim instead.
  if (probe.includes('size limit') || (probe.includes('exceed') && probe.includes('mb'))) {
    return oversizeResult(serverMessage, attachments)
  }
  if (probe.includes('too many files')) return overcountResult(serverMessage)

  // FinScore could not verify the mobile number. Fixable by the applicant, so
  // it gets its own screen instead of a generic server error.
  if (status === 422 || data?.status === 'phone_not_found') {
    return {
      status: 'error',
      title: 'Mobile Number Not Verified',
      message: `${serverMessage || 'The mobile number provided could not be verified.'} Nothing was saved.`,
      suggestions: PHONE_FIXES,
      actionLabel: 'Correct My Number',
    }
  }

  // A 400 whose body we could not read, on a submit that carried files, is
  // almost always the upload gate: every other 400 path on this endpoint is a
  // handled JSON response that arrives intact. Say the useful thing rather than
  // "the server rejected the request".
  if (status === 400 && !serverMessage && attachments?.count > 0) {
    return oversizeResult(null, attachments)
  }

  // 5xx is an unhandled exception, not a rejection — every handled outcome on
  // this endpoint is a 200. Saying "rejected" or "check your connection" here
  // sends the applicant looking for a mistake that is ours, not theirs.
  if (status >= 500 && !serverMessage) return serverFaultResult(status)

  if (serverMessage) {
    return {
      status: 'error',
      title: 'Something Went Wrong',
      message: `${serverMessage} Nothing was saved — please try again.`,
      suggestions: [],
    }
  }

  return {
    status: 'error',
    title: 'Something Went Wrong',
    message: `The server rejected the request (error ${status}). Nothing was saved — please try again.`,
    suggestions: [
      'Check your internet connection and submit again.',
      'If this keeps happening, contact us and quote the error number above.',
    ],
  }
}

/**
 * Build the result screen for a submit that ended with no HTTP status
 * (a SubmitTransportError from submitTransport.js).
 *
 * The phase decides everything. Cut off during the upload, the backend never
 * had the whole application and saved nothing, so say so plainly and let the
 * applicant send it again with every entry still filled in. Cut off after the
 * upload, the backend may have saved it, so keep the "don't submit again"
 * screen: a false retry creates a duplicate application.
 * @param {{phase: 'upload'|'response'}} err
 * @returns {{status:string,title?:string,message:string,suggestions?:string[],actionLabel?:string}}
 */
export function buildTransportFailureResult(err) {
  if (err.phase === 'upload') {
    return {
      status: 'error',
      title: 'Your Application Was Not Received',
      message:
        'The connection dropped or slowed down too much while your documents were uploading, so nothing was saved. Everything you entered is still here — you can send it again.',
      suggestions: [
        'Move to a spot with a stronger signal, or switch to Wi-Fi, before sending again.',
        'Keep this page open and the screen on until you see your reference number.',
      ],
      actionLabel: 'Send Again',
    }
  }
  return {
    status: 'uncertain',
    message:
      "Your application is taking longer than expected to confirm. It may still have gone through — please don't submit again. If you don't receive a reference number, contact us first.",
  }
}
