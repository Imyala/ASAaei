# Making it fast — ideas backlog

The goal is to beat "draw text boxes in Adobe every time." What's shipped and what's next,
roughly in order of time saved per dollar of effort.

## Shipped

- **Open ready to fill.** A form is recognised by its document number (`AEI 3.4106`). Save a
  layout once and every future open of that form — by file or by work order — re-applies it and
  lands in fill mode.
- **Auto-detect fields** (Word + PDF): OK/Fail/N/A dropdowns in status columns, text fields for
  Remarks and details blocks, signature blocks.
- **Page picker**: skip the reading pages, fill only the pages that matter.
- **Work-order search** (with the `server/` middleware): enter a WO → pull the form → open it
  prefilled.

## High value, low effort — do next

1. **Ship a starter template pack.** Pre-build layouts for the standard AEI forms (3.4106,
   3.3007, …) so techs get "ready to fill" on day one with zero setup. Templates already
   export/import as files — we just bundle a set and load them on first run.
2. **Profile autofill.** Store the tech's name + SAP ID once; auto-fill "Inspected by (Name)",
   "SAP ID", and "Date inspected" (today) on open. Saves typing the same fields every job.
3. **"Set column to OK, then flag exceptions."** One tap sets a whole status column to OK; the
   tech only changes the few that failed. This is the single biggest keystroke saver on a
   200-line checklist.
4. **Carry over the last inspection.** Pre-fill from the previous signed record for the same
   unit, so only changes are entered.
5. **Barcode / QR scan** (device camera) to fill Unit No / serial / asset number instead of
   typing — the PWA can use the camera with no extra install.

## Medium

6. **Layout learning across versions.** When a form's version changes and field positions shift,
   snap the saved layout to the new text positions automatically (we already read text positions
   for detection).
7. **Validation & completeness.** Warn on required-but-empty fields before lock/download; flag a
   "Fail" with no remark.
8. **N: drive / SAP close-out** (Phases 4–5 in ARCHITECTURE.md) via the same middleware.

## A "lite offline model" — where it helps, where it doesn't

The app is an offline PWA, so anything shipped must be small and run on-device. An LLM is the
wrong tool for most of this — deterministic features above are faster and more reliable. Realistic
on-device AI uses, worth it only if the simple wins are exhausted:

- **Voice-to-text for Remarks** — the biggest genuine win. Hands are often dirty/gloved; dictating
  a remark beats typing. Two routes:
  - **Web Speech API** — zero download, but quality/offline support varies by device/browser.
  - **On-device Whisper-tiny/base** (via `transformers.js` + WebGPU/WASM) — ~40–75 MB, fully
    offline, good accuracy. Ships as an optional download so the base app stays light.
- **Smart field-label matching** — a *tiny* model (or just fuzzy string matching, no model) to map
  a form's labels to known field types when auto-detect is unsure. Fuzzy matching is likely enough;
  a model is overkill.
- **Free-text → structured** — e.g. dictate "pump 3 failed, bearing noise" and have it set the
  right row to Fail + fill the remark. This is the one place a small instruction-tuned model adds
  real value, but it's the heaviest option; revisit after voice-to-text.

Recommendation: do the deterministic wins (1–5) first; add **voice-to-text for Remarks** as the
first "AI" feature since it targets the slowest real-world step (typing notes on a tablet in the
field). Treat any model as an **optional, downloaded-once** add-on so the core PWA stays small and
instant.
