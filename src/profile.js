// The tech's own details, stored on the device, used to auto-fill the fields
// that are the same on every job (their name, SAP ID) plus today's date — so
// those are already filled the moment a form opens.

const KEY = 'asaaei:profile'

export function getProfile() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} }
}

export function setProfile(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p || {})) } catch { /* ignore */ }
}

function shortDate() {
  return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
}

// Fill matching *empty text* fields from the profile. Never overwrites a value
// the tech already entered. Returns a new fields array.
export function applyProfile(fields, profile) {
  const p = profile || {}
  const today = shortDate()
  return fields.map((f) => {
    if (f.type !== 'text' || f.value) return f
    const l = (f.label || '').toLowerCase()
    let v = ''
    if (/(inspected|checked)\s*by.*name|^inspector|technician|^name\b/.test(l)) v = p.name || ''
    else if (/sap\s*(id|no|number)|personnel\s*(no|number)/.test(l)) v = p.sapId || ''
    else if (/date\s*inspected|inspection\s*date|^date\b/.test(l)) v = p.fillDate === false ? '' : today
    return v ? { ...f, value: v } : f
  })
}
