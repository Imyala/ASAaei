# ASAaei work-order middleware

A small, self-contained Express service that lets the **ASAaei** PWA (a
document fill/sign app that can run on an iPad) look up an **SAP work order**
and locate its inspection form in the Airservices Australia **Document Centre**
(a SharePoint site at `orbit.hub.airservicesaustralia.com/sites/DocCentre`).

## Why it's needed

A browser — especially an iPad — **cannot talk to SAP or SharePoint directly**:

- There is no SAP GUI in a browser, and SAP Gateway/BAPI endpoints live inside
  the company network behind auth a public web page can't present.
- The Document Centre SharePoint site requires corporate auth and would block
  cross-origin browser requests (CORS) anyway.

So the app calls this **thin middleware**, which runs *inside the network* and
does the real SAP + SharePoint work server-side, returning a small JSON summary
and streaming the document bytes back through its own origin (no SharePoint
CORS/auth reaches the browser).

## Modes

- **MOCK** — fully self-contained. Sample work order, sample search result, and
  an inspection PDF generated on the fly with `pdf-lib`. No SAP/SharePoint
  needed. Enabled when `MOCK=1`, or automatically whenever the SAP/SharePoint
  env vars aren't set.
- **REAL** — calls SAP OData (basic auth) and the SharePoint Search REST API
  (bearer token, with a hook for NTLM/cookie auth).

## Run it

```bash
cd server
npm install

# Demo / offline (no SAP or SharePoint required):
MOCK=1 npm start

# Real mode: set the SAP_* and SP_* vars first (see .env.example), then:
npm start
```

Config is read from **environment variables** only (no dotenv). Either export
the vars in your shell / process manager, or:

```bash
set -a; . ./.env; set +a   # if you copied .env.example -> .env
npm start
```

The service listens on `PORT` (default `8080`).

## Endpoints

All responses are JSON (except `/documents/fetch`, which streams the file).
CORS allows `ALLOWED_ORIGIN` (default `*`) for these GET endpoints.

### `GET /health`

```bash
curl http://localhost:8080/health
# {"ok":true,"mock":true}
```

### `GET /workorders/:number`

Returns the order header plus a derived `documentQuery` describing which
Document Centre form to look for.

```bash
curl http://localhost:8080/workorders/2112345
```

```json
{
  "number": "2112345",
  "description": "Cooling Tower Performance Inspection",
  "status": "REL",
  "plant": "SYD",
  "equipment": "CT-01",
  "functionalLocation": "SYD-MECH-CT-01",
  "documentQuery": {
    "documentNumber": "AEI-3.3007",
    "keywords": "Cooling Towers Performance inspection record",
    "systems": "Mechanical"
  }
}
```

Returns **404** if the order is not found (real mode).

### `GET /documents/search?documentNumber=&keywords=&systems=&title=`

Ranked list of matching Document Centre files, best-first. Each result's `url`
points back at this service's `/documents/fetch` proxy.

```bash
curl "http://localhost:8080/documents/search?keywords=cooling"
```

```json
{
  "results": [
    {
      "documentNumber": "AEI-3.3007",
      "title": "Cooling Towers Performance inspection record",
      "fileName": "AppendixB.pdf",
      "url": "http://localhost:8080/documents/fetch?src=mock%3AappendixB",
      "score": 0.95
    }
  ]
}
```

### `GET /documents/fetch?src=<url>`

Streams the document bytes with the correct `Content-Type` and a
`Content-Disposition` filename. In mock mode, `src=mock:appendixB` generates a
one-page A4 inspection PDF with a `1M 3M 6M 1Y Remarks` header row and blank
status/Remarks cells so the app's PDF field auto-detection can find the columns.

```bash
curl -s "http://localhost:8080/documents/fetch?src=mock:appendixB" -o /tmp/AppendixB.pdf
file /tmp/AppendixB.pdf   # -> PDF document
```

## Point the ASAaei app at this service

The app reads its middleware base URL from either:

- **localStorage** — set `asaaei:workorderApi` to this service's base URL, e.g.
  ```js
  localStorage.setItem('asaaei:workorderApi', 'http://localhost:8080')
  ```
  (IT can point the app at the server without a rebuild.)
- **Build-time env** — set `VITE_WORKORDER_API=http://your-middleware:8080`
  before `npm run build` in the app.

The app then calls `GET {base}/workorders/{number}` (see `src/sap.js`).

## Environment variables

| Variable         | Default                                                          | Purpose                                                            |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `PORT`           | `8080`                                                           | Port to listen on.                                                |
| `ALLOWED_ORIGIN` | `*`                                                              | CORS origin allowed to call the GET endpoints.                    |
| `MOCK`           | (unset)                                                          | `1`/`true` forces mock mode. Auto-on when SAP/SP vars are unset.  |
| `SAP_ODATA_URL`  | (unset)                                                          | SAP Gateway OData service root for the order header.              |
| `SAP_USER`       | (unset)                                                          | Basic-auth user for SAP.                                          |
| `SAP_PASS`       | (unset)                                                          | Basic-auth password for SAP.                                      |
| `SP_BASE_URL`    | `https://orbit.hub.airservicesaustralia.com/sites/DocCentre`     | Document Centre site collection base URL.                         |
| `SP_BEARER`      | (unset)                                                          | Bearer token for the SharePoint REST/Search API.                  |

REAL mode is used only when **all** of `SAP_ODATA_URL`, `SAP_USER`, `SAP_PASS`
**and** `SP_BASE_URL`, `SP_BEARER` are set; otherwise the service stays in mock
mode.

## CORS, auth & security notes

- **Run inside the network.** This service holds SAP and SharePoint
  credentials — deploy it on an internal host, not on the public internet.
- **Restrict `ALLOWED_ORIGIN` in production** to the exact origin the ASAaei PWA
  is served from. `*` is for demos only. When a specific origin is set the
  service also enables `Access-Control-Allow-Credentials` so the app's
  `credentials: 'include'` fetches work.
- **Use a service account / SSO.** Prefer a least-privilege SAP service account
  and a scoped SharePoint app registration / OAuth bearer token over personal
  credentials.
- Keep all secrets in environment variables (never commit `.env`).

## TODO markers — fill in for your environment

Search `index.js` for `TODO(IT)`:

1. **SAP OData entity path** — confirm the entity set / key that returns the
   order header (e.g. `OrderHeaderSet('2112345')`, or a custom OData wrapper
   around `BAPI_ALM_ORDER_GET_DETAIL`) and map the real field names.
2. **SAP → documentQuery derivation** — if orders/task lists link a DMS document
   number, map it into `documentQuery.documentNumber`.
3. **SharePoint auth** — supply `SP_BEARER`, or replace the bearer header with
   NTLM / FedAuth-cookie auth in `sharePointAuthHeaders()`.
