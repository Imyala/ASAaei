// Tiny IndexedDB key/value store — no dependencies, works offline.
// Used for form templates and the last-downloaded copy of each source document.
const DB = 'asaaei'
const STORE = 'kv'

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function get(key) {
  const db = await open()
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}
async function set(key, val) {
  const db = await open()
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(val, key)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}
async function del(key) {
  const db = await open()
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

// ---- templates -----------------------------------------------------------
// Index of templates: [{ id, name, createdAt, fieldCount }]
const INDEX = 'templates:index'
const seq = () => 't' + Math.abs(Date.now()).toString(36) + Math.floor(performance.now()).toString(36)

export async function listTemplates() {
  return (await get(INDEX)) || []
}
export async function loadTemplate(id) {
  return get('template:' + id)
}
export async function saveTemplate(name, fields, meta = {}) {
  const id = seq()
  const clean = fields.map(stripValue)
  const { docKey = '', docTitle = '', pages = [] } = meta
  const tpl = { id, name, createdAt: new Date().toISOString(), fields: clean, docKey, docTitle, pages }
  await set('template:' + id, tpl)
  const index = await listTemplates()
  index.push({ id, name, createdAt: tpl.createdAt, fieldCount: clean.length, docKey })
  await set(INDEX, index)
  return tpl
}

// Find the saved template whose form identity matches `docKey` (if any).
export async function findTemplateByDocKey(docKey) {
  if (!docKey) return null
  return (await listTemplates()).find((t) => t.docKey && t.docKey === docKey) || null
}
export async function deleteTemplate(id) {
  await del('template:' + id)
  await del('doc:' + id)
  await set(INDEX, (await listTemplates()).filter((t) => t.id !== id))
}

// Reset any filled-in data so a template only stores the field layout.
function stripValue(f) {
  return { ...f, value: f.type === 'signature' ? null : '' }
}

// ---- cached source document (for offline use) ----------------------------
// The last file opened with a saved fill layout is kept so it can be reopened
// straight away (and while offline) without picking the file again.
export async function cacheDoc(templateId, name, bytes) {
  await set('doc:' + templateId, { name, bytes, savedAt: new Date().toISOString() })
}
export async function getCachedDoc(templateId) {
  return get('doc:' + templateId)
}

// ---- import / export (share templates across devices) --------------------
export function exportTemplate(tpl) {
  return JSON.stringify({ kind: 'asaaei-template', version: 1, template: tpl }, null, 2)
}
export async function importTemplateJson(text) {
  const data = JSON.parse(text)
  const t = data.template || data
  if (!Array.isArray(t.fields)) throw new Error('Not a valid template file.')
  return saveTemplate(t.name || 'Imported template', t.fields)
}
