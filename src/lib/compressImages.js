/**
 * Shrinks photos in the browser before a loan form uploads them.
 *
 * Why this exists: field submits from phones carry 4–6 photos per member, each
 * several MB straight off the camera. A Group/SBL submit is 40–120MB, and on a
 * weak connection the upload never finishes (Ondillo Group, 2026-11-15: 66MB,
 * cut off mid-upload, nothing saved). The backend already resizes every photo
 * to the settings below once the upload lands (loan-backend
 * services/compress.js), so doing the same here first loses nothing it would
 * have stored, and sends a fraction of the bytes.
 *
 * Every failure falls back to the original file: a photo that can't be decoded
 * here is still uploaded as-is and the backend handles it as before.
 */

// Mirror of the backend resize (services/compress.js: width 2000, JPEG q80,
// no height cap). Keep in step with it; going lower would store less detail
// than the backend keeps today.
const MAX_WIDTH = 2000
const JPEG_QUALITY = 0.8
// Photos already this small and narrow are sent untouched.
const SKIP_BELOW_BYTES = 1024 * 1024

const COMPRESSIBLE_TYPES = ['image/jpeg', 'image/jpg', 'image/png']

// Decoded through an <img> on purpose: every current browser applies the
// photo's EXIF rotation when drawing an <img>, and the canvas output drops
// EXIF, so a decode that ignored rotation would store a portrait ID sideways.
async function decode(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function toJpegBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
}

function jpegName(name) {
  const base = name.replace(/\.[^./\\]+$/, '')
  return `${base || 'photo'}.jpg`
}

/**
 * Compress one photo. Returns the original file when it isn't a JPEG/PNG, is
 * already small, can't be decoded, or wouldn't come out smaller.
 * @param {File} file
 * @returns {Promise<File>}
 */
export async function compressImage(file) {
  if (!COMPRESSIBLE_TYPES.includes((file.type || '').toLowerCase())) return file
  try {
    const image = await decode(file)
    const width = image.naturalWidth
    const height = image.naturalHeight
    if (!width || !height) return file
    if (file.size < SKIP_BELOW_BYTES && width <= MAX_WIDTH) return file

    const scale = Math.min(1, MAX_WIDTH / width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const ctx = canvas.getContext('2d')
    // JPEG has no transparency: paint PNG see-through areas white, not black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await toJpegBlob(canvas)
    // Release the canvas backing store now; phones run out of memory fast.
    canvas.width = 0
    canvas.height = 0
    if (!blob || blob.size >= file.size) return file
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } catch (err) {
    console.warn('[compressImage] sending original', file.name, err)
    return file
  }
}

/**
 * Copy a FormData with every photo compressed, keeping field order and names.
 * Photos are done one at a time so a 24-photo group doesn't hold 24 decoded
 * images in a phone's memory at once.
 * @param {FormData} fd
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<FormData>}
 */
export async function compressFormDataImages(fd, onProgress) {
  const entries = [...fd.entries()]
  const total = entries.filter(([, v]) => v instanceof File).length
  const out = new FormData()
  let done = 0
  for (const [key, value] of entries) {
    if (value instanceof File) {
      const file = await compressImage(value)
      out.append(key, file, file.name)
      done++
      onProgress?.(done, total)
    } else {
      out.append(key, value)
    }
  }
  return out
}
