# Shipping Service — API Documentation

Parses Royal Mail label PDFs, extracts shipment fields, stores them in Postgres, and returns the data as **CSV** or **JSON**.

- **Base URL (local):** `http://localhost:3014`
- **CORS:** enabled. Defaults to `*` locally; restricted per `CORS_ORIGIN` in other environments.

> All request bodies for the parse endpoints are **`multipart/form-data`**. Do **not** set `Content-Type` manually in `fetch`/`axios` when sending `FormData` — the browser sets the boundary automatically.

---

## Endpoint summary

| Method | Path | Body (form field) | Success returns |
|--------|------|-------------------|-----------------|
| `GET`  | `/health` | — | JSON status |
| `POST` | `/api/shipping/parse-labels-csv` | `file` (1 PDF) | **CSV file** (download) |
| `POST` | `/api/shipping/parse-labels-csv-multi` | `files` (1–25 PDFs) | **CSV file** (download) |
| `POST` | `/api/shipping/parse-labels` | `file` (1 PDF) | JSON (array) |
| `POST` | `/api/shipping/parse-label` | `file` (1 PDF) | JSON (single) |

**Constraints:** max file size **25 MB** per file. The multi endpoint accepts up to **25** files, which are merged server-side before parsing.

---

## Data models

### `ExtractedLabel` (parsing output)

Returned by the JSON endpoints inside `extracted`. Any field may be `null` when the parser can't find it in the PDF.

| Key | Type | Notes |
|-----|------|-------|
| `tracking_number` | `string \| null` | e.g. `"MV 0979 7959 1GB"` (normalized: uppercase, single-spaced) |
| `customer_ref` | `string \| null` | e.g. `"ORD-10432"` |
| `recipient_name` | `string \| null` | e.g. `"John Smith"` |
| `address_text` | `string \| null` | comma-joined address lines |
| `postcode` | `string \| null` | e.g. `"SW1A 1AA"` (normalized) |
| `service_name` | `string \| null` | `"Tracked 24"` or `"Tracked 48"` |
| `postage_cost` | `number \| null` | e.g. `3.35` (**number** here) |
| `postage_currency` | `string \| null` | `"GBP"` when a cost was found, else `null` |
| `label_date` | `string \| null` | `"dd.mm.yyyy"`, e.g. `"12.07.2026"` |

### `SavedLabel` (database row)

Returned inside `saved`. This is the persisted row and has **more fields** than `ExtractedLabel`. It is `null` when the row could not be returned (see note on `null` tracking numbers).

| Key | Type | Notes |
|-----|------|-------|
| `id` | `number` | auto-increment primary key |
| `tracking_number` | `string \| null` | unique key |
| `customer_ref` | `string \| null` | |
| `recipient_name` | `string \| null` | |
| `address_text` | `string \| null` | |
| `postcode` | `string \| null` | |
| `service_name` | `string \| null` | |
| `postage_cost` | `string \| null` | ⚠️ **string** here (e.g. `"3.35"`), not a number — Postgres returns `DECIMAL` as a string |
| `postage_currency` | `string \| null` | |
| `label_date` | `string \| null` | |
| `source_filename` | `string \| null` | saved PDF filename on the server |
| `raw_text` | `string \| null` | full extracted text for this label (can be large) |
| `created_at` | `string` | ISO 8601 timestamp |

### CSV format (CSV endpoints)

Exactly three columns, one header row, one row per parsed label:

```csv
Full Name,Postal Code,Tracking Number
John Smith,SW1A 1AA,MV 0979 7959 1GB
```

Empty values are emitted as empty strings. Values containing commas/quotes/newlines are quoted per RFC 4180.

### Error object (all endpoints)

```json
{ "error": "human-readable message" }
```

---

## `GET /health`

Liveness check. Does **not** verify the database.

**Request:** none.

**Response `200`**

```json
{
  "status": "healthy",
  "service": "shipping-service",
  "timestamp": "2026-07-06T12:34:56.789Z"
}
```

| Key | Type |
|-----|------|
| `status` | `string` — `"healthy"` |
| `service` | `string` — `"shipping-service"` |
| `timestamp` | `string` — ISO 8601 |

---

## `POST /api/shipping/parse-labels-csv`

Parse **one** PDF and download a CSV. Automatically runs OCR fallback if the PDF has no text layer or extraction is weak (requires OCR tooling installed on the server).

**Request**

- Content-Type: `multipart/form-data`
- Form field: `file` — a single PDF (≤ 25 MB)

**Response `200`**

- Content-Type: `text/csv; charset=utf-8`
- Content-Disposition: `attachment; filename="<name>.csv"`
- Body: CSV text (see CSV format above)

**Errors**

| Status | Body | When |
|--------|------|------|
| `400` | `{ "error": "file is required (multipart form-data field name: file)" }` | no `file` field |
| `422` | `{ "error": "No text could be extracted from the PDF. This PDF might be image-only and require OCR." }` | no text and OCR unavailable/failed |
| `422` | `{ "error": "No text could be extracted and OCR failed: <reason>" }` | OCR attempted and failed (e.g. binary not installed) |
| `500` | `{ "error": "<message>" }` | unexpected server error |

**Example**

```js
const fd = new FormData();
fd.append("file", pdfFile); // File/Blob

const res = await fetch(`${baseUrl}/api/shipping/parse-labels-csv`, {
  method: "POST",
  body: fd, // do NOT set Content-Type manually
});

if (!res.ok) {
  const { error } = await res.json();
  throw new Error(error);
}
const blob = await res.blob(); // text/csv — trigger a download
```

---

## `POST /api/shipping/parse-labels-csv-multi`

Merge **multiple** PDFs (1–25) into one document server-side, parse, and download a combined CSV.

**Request**

- Content-Type: `multipart/form-data`
- Form field: `files` — repeat the field once per PDF (up to 25), each ≤ 25 MB

**Response `200`**

- Content-Type: `text/csv; charset=utf-8`
- Content-Disposition: `attachment; filename="<name>.csv"`
- Body: CSV text, one data row per label found across all merged PDFs

**Errors**

| Status | Body | When |
|--------|------|------|
| `400` | `{ "error": "files are required (multipart form-data field name: files)" }` | no `files` field |
| `422` | `{ "error": "Failed to merge PDFs (empty output)" }` | merge produced nothing |
| `422` | `{ "error": "No text could be extracted from the PDF. This PDF might be image-only and require OCR." }` | no text and OCR unavailable |
| `422` | `{ "error": "No text could be extracted and OCR failed: <reason>" }` | OCR failed |
| `500` | `{ "error": "<message>" }` | unexpected server error |

**Example**

```js
const fd = new FormData();
for (const f of pdfFiles) fd.append("files", f); // same field name each time

const res = await fetch(`${baseUrl}/api/shipping/parse-labels-csv-multi`, {
  method: "POST",
  body: fd,
});
const blob = await res.blob();
```

---

## `POST /api/shipping/parse-labels`

Parse **one** PDF and return JSON for **all** labels found in it. Does **not** run OCR fallback.

**Request**

- Content-Type: `multipart/form-data`
- Form field: `file` — a single PDF (≤ 25 MB)

**Response `200`**

```json
{
  "success": true,
  "count": 1,
  "extracted": [
    {
      "tracking_number": "MV 0979 7959 1GB",
      "customer_ref": "ORD-10432",
      "recipient_name": "John Smith",
      "address_text": "12 Baker Street, London, SW1A 1AA",
      "postcode": "SW1A 1AA",
      "service_name": "Tracked 24",
      "postage_cost": 3.35,
      "postage_currency": "GBP",
      "label_date": "12.07.2026"
    }
  ],
  "saved": [
    {
      "id": 1,
      "tracking_number": "MV 0979 7959 1GB",
      "customer_ref": "ORD-10432",
      "recipient_name": "John Smith",
      "address_text": "12 Baker Street, London, SW1A 1AA",
      "postcode": "SW1A 1AA",
      "service_name": "Tracked 24",
      "postage_cost": "3.35",
      "postage_currency": "GBP",
      "label_date": "12.07.2026",
      "source_filename": "labels.pdf",
      "raw_text": "MV 0979 7959 1GB\nRoyal Mail Tracked 24\n...",
      "created_at": "2026-07-06T12:34:56.789Z"
    }
  ]
}
```

| Key | Type |
|-----|------|
| `success` | `boolean` — always `true` on 200 |
| `count` | `number` — length of `extracted` |
| `extracted` | `ExtractedLabel[]` |
| `saved` | `(SavedLabel \| null)[]` — same order as `extracted`; entry is `null` when that label had no tracking number |

**Errors**

| Status | Body | When |
|--------|------|------|
| `400` | `{ "error": "file is required (multipart form-data field name: file)" }` | no `file` field |
| `422` | `{ "error": "No text could be extracted from the PDF. This PDF might be image-only and require OCR." }` | no extractable text (this route has no OCR fallback) |
| `500` | `{ "error": "<message>" }` | unexpected server error |

**Example**

```js
const fd = new FormData();
fd.append("file", pdfFile);

const res = await fetch(`${baseUrl}/api/shipping/parse-labels`, { method: "POST", body: fd });
const data = await res.json(); // { success, count, extracted, saved }
```

---

## `POST /api/shipping/parse-label`

Parse **one** PDF and return JSON for only the **first** label found. Does **not** run OCR fallback.

**Request**

- Content-Type: `multipart/form-data`
- Form field: `file` — a single PDF (≤ 25 MB)

**Response `200`**

```json
{
  "success": true,
  "extracted": {
    "tracking_number": "MV 0979 7959 1GB",
    "customer_ref": "ORD-10432",
    "recipient_name": "John Smith",
    "address_text": "12 Baker Street, London, SW1A 1AA",
    "postcode": "SW1A 1AA",
    "service_name": "Tracked 24",
    "postage_cost": 3.35,
    "postage_currency": "GBP",
    "label_date": "12.07.2026"
  },
  "saved": {
    "id": 1,
    "tracking_number": "MV 0979 7959 1GB",
    "customer_ref": "ORD-10432",
    "recipient_name": "John Smith",
    "address_text": "12 Baker Street, London, SW1A 1AA",
    "postcode": "SW1A 1AA",
    "service_name": "Tracked 24",
    "postage_cost": "3.35",
    "postage_currency": "GBP",
    "label_date": "12.07.2026",
    "source_filename": "label.pdf",
    "raw_text": "MV 0979 7959 1GB\n...",
    "created_at": "2026-07-06T12:34:56.789Z"
  }
}
```

| Key | Type |
|-----|------|
| `success` | `boolean` — always `true` on 200 |
| `extracted` | `ExtractedLabel` (single object, not array) |
| `saved` | `SavedLabel \| null` — `null` when no tracking number was found |

**Errors**

| Status | Body | When |
|--------|------|------|
| `400` | `{ "error": "file is required (multipart form-data field name: file)" }` | no `file` field |
| `422` | `{ "error": "No text could be extracted from the PDF. This PDF might be image-only and require OCR." }` | no extractable text |
| `500` | `{ "error": "<message>" }` | unexpected server error |

---



## Notes / gotchas for the frontend

1. **CSV vs JSON:** `parse-labels-csv` and `parse-labels-csv-multi` return a **CSV file** (`text/csv`), not JSON. Read them with `res.blob()` / `res.text()` and trigger a download. The other two return JSON.
2. **`postage_cost` type differs:** it's a **number** in `extracted` but a **string** in `saved` (Postgres returns `DECIMAL` as a string). Parse with `Number(...)` if you need a number from `saved`.
3. **`null` fields are normal.** If the PDF is not a recognized Royal Mail label, the parser returns all fields `null` (JSON: `success:true` with null fields; CSV: header row only, no data rows). This is expected input-format behavior, not a server error.
4. **`saved` can be `null`** for any label whose `tracking_number` is `null` (no unique key to return the row by).
5. **OCR fallback only on the CSV endpoints.** `parse-labels` and `parse-label` do not OCR; an image-only PDF returns `422`. The CSV endpoints attempt OCR, which requires `ocrmypdf` + Tesseract installed on the server — if absent, they also return `422` with an OCR-unavailable message.
6. **Do not set `Content-Type` manually** when posting `FormData`; let the browser set the multipart boundary.
7. **Duplicate handling:** labels are upserted by `tracking_number`. Re-uploading the same label updates the existing row rather than creating a duplicate.
8. **Field lengths (DB):** `tracking_number` ≤ 40, `postcode` ≤ 20, `recipient_name` ≤ 160, `customer_ref`/`service_name` ≤ 80, `postage_currency` ≤ 10, `label_date` ≤ 40, `source_filename` ≤ 255 characters.