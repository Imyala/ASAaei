# ASAaei — Document → N: Drive → SAP Workflow App

**Status:** Design + Phase-1 prototype
**Audience:** the team building this, plus IT/Basis for the integration questions in §5.

---

## 1. What we are building

A single app that walks a user through one document at a time:

1. **PICK** — get the source document from SharePoint ("Horizons").
2. **EDIT** — open the Word/PDF, fill it in with prefillable fields (text, dropdowns,
   OK/Fail/N/A tick boxes), and sign it (name + date/time, Outlook-style).
3. **LOCK & SAVE** — once signed, the document can no longer be edited (only further
   signatures may be added); the finished **PDF** is written to an **N: drive** folder.
4. **CLOSE** — collect the SAP fields and close the work order (IW32/IW42, Plant Maintenance).

This replaces today's manual process of hand-drawing text boxes on a PDF.

## 2. Devices it must run on

Windows desktops, touchscreen/laptops, **and iPads/tablets**.

That last one is the deciding constraint. An iPad cannot:
- run a native Windows program,
- map or write to an `N:` drive,
- run SAP GUI.

So the app is a **responsive web app** (runs in any browser), backed by a **server that
lives inside the company network** and performs the steps a browser/iPad physically cannot.

```
   DEVICE (any browser)                 SERVER (inside the network)
 ┌────────────────────┐              ┌──────────────────────────────┐
 │ iPad / tablet      │              │ • pull source doc from        │
 │ touchscreen laptop │◄────────────►│   SharePoint / "Horizons"     │
 │ Windows desktop    │   HTTPS      │ • write finished PDF to the   │
 │                    │              │   N: drive (UNC path)         │
 │ pick→fill→sign→send│              │ • close SAP work order        │
 └────────────────────┘              └──────────────────────────────┘
```

- **Filling & signing** happen on the device — works everywhere.
- **N: drive save** and **SAP close-out** happen server-side, so the iPad never needs
  direct access to either.

## 3. The document engine (the core value)

Everything the user asked for maps onto standard **PDF form + signature** technology:

| Requirement                                   | How it is done                                             |
|-----------------------------------------------|------------------------------------------------------------|
| Word doc sometimes provided                   | Convert Word → PDF server-side (Phase 2)                   |
| Prefillable fields, dropdowns, tick boxes     | PDF **AcroForm** fields (text / choice / checkbox)         |
| OK / Fail / N/A                               | A checkbox/radio group per line item                       |
| Signature with name + date/time (Outlook-like)| A signature block stamped with signer name + timestamp     |
| Locked after signing, except more signatures  | The form is **flattened/locked** on signing; only signature fields stay open |
| Must be saved as PDF                           | Output is always a flattened PDF                           |

**Tamper-proofing note:** the Phase-1 prototype enforces "no longer editable" at the app
level by flattening the fields. For legally-robust, tamper-*evident* documents we later add
**cryptographic PDF signatures** (PKI certificate + DocMDP field lock). That is an upgrade,
not required for the first working version.

## 4. Build phases (deliver value before IT unblocks the integrations)

| Phase | Deliverable                                                        | Needs IT? |
|-------|--------------------------------------------------------------------|-----------|
| **1** | Web app: open PDF, place fields, fill, sign+timestamp, lock, download | No       |
| **2** | Word→PDF conversion; save reusable field templates per form type    | No        |
| **3** | Pull source documents from SharePoint / Horizons                    | Yes (Q1)  |
| **4** | Server writes the finished PDF to the N: drive automatically         | Yes (Q2)  |
| **5** | Collect SAP fields and close the IW32/IW42 work order               | Yes (Q3)  |

**Phase 1 is in this repo** (see the app at the project root). It runs in a browser with no
server and no IT access, so the team can try the fill/sign/lock flow on any device today.

## 5. Questions for IT / Basis (each unblocks one phase)

1. **SharePoint / "Horizons"** — Is Horizons *SharePoint Online (Microsoft 365)* or an
   *on-prem SharePoint server*? Can we get an app registration / API permission to read a
   document library? (Unblocks Phase 3.)
2. **N: drive** — What is the real UNC path behind `N:` (e.g. `\\fileserver\share\folder`)?
   Can a service account get write access to the target folder? (Unblocks Phase 4.)
3. **SAP** — To close IW32/IW42 work orders programmatically, can Basis expose a
   **BAPI** (`BAPI_ALM_ORDER_MAINTAIN`) or an **OData/SAP Gateway** service? If neither,
   can we run **SAP GUI Scripting** from a Windows service account? (BAPI/OData is far more
   reliable than GUI scripting — strongly preferred.) (Unblocks Phase 5.)

## 6. Recommended stack

- **Front-end:** React (Vite), open-source PDF libraries `pdf-lib` (write/fill/flatten) and
  `pdf.js` (render). No license fees.
- **Back-end (Phase 3+):** a small service inside the network. .NET is a good fit if the
  company is Microsoft-heavy (clean SharePoint + SAP .NET Connector paths); Node also works.
- **SAP:** prefer BAPI/OData over GUI scripting for reliability.

## 7. Security / sign-off notes

- Company single sign-on (Microsoft Entra ID) for login once the server exists.
- Every finished document logged (who, what work order, when, N: path).
- Signed PDFs are immutable; re-opening a signed doc allows adding signatures only.
