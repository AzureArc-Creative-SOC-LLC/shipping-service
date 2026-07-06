# Shipping Service

A Node.js/Express microservice that parses **Royal Mail label PDFs**, extracts shipment fields (tracking number, recipient, postcode, service, postage cost, date), stores them in **Supabase Postgres**, and returns the data as **CSV** or **JSON**. Falls back to OCR for image-only PDFs.

---

## Features

- Upload a single label PDF or merge up to **25** PDFs in one request
- Extracts: tracking number, customer ref, recipient name, address, postcode, service (Tracked 24/48), postage cost, and label date
- Returns results as a **CSV download** or as **JSON**
- **OCR fallback** (`ocrmypdf` + Tesseract) when a PDF has no text layer
- Saves source PDFs and generated CSVs to disk (`LABELS_DIR`)

## Tech stack

- **Runtime:** Node.js ≥ 18, Express
- **Database:** Supabase Postgres via [`pg`](https://node-postgres.com/)
- **PDF:** `pdf-parse` (text extraction), `pdf-lib` (merge), `ocrmypdf` + `tesseract-ocr` (OCR fallback)
- **Uploads:** `multer` (in-memory, 25 MB limit)

---

## Prerequisites

- Node.js **18+** and npm
- A **Supabase Postgres** database (connection string)
- For the OCR fallback (optional but recommended), these **system binaries** on the host `PATH`:

  ```bash
  # Debian/Ubuntu
  sudo apt-get update && sudo apt-get install -y ocrmypdf tesseract-ocr tesseract-ocr-eng ghostscript

  # macOS
  brew install ocrmypdf tesseract ghostscript
  ```

  > Without these, image-only PDFs return `422`. Text-based PDFs still work fine.

---

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Create a .env file (see below)

# 3. Start the service
npm start        # or: npm run dev
```

On boot the service loads `.env`, connects to Postgres, and creates the `shipping_labels` table if it doesn't exist. It then listens on `SHIPPING_SERVICE_PORT` (default `3014`).

Health check:

```bash
curl http://localhost:3014/health
# { "status": "healthy", "service": "shipping-service", "timestamp": "..." }
```

---

## Environment variables

Create a `.env` file in the service root:

```dotenv
# Required — Supabase Postgres connection string
DATABASE_URL=postgresql://postgres:PASSWORD@HOST:6543/postgres

# Server
SHIPPING_SERVICE_PORT=3014

# Optional
CORS_ORIGIN=*                         # comma-separated origins in production
LABELS_DIR=/var/www/backend/labels    # where source PDFs + CSVs are written
```


---

## API

Base URL (local): `http://localhost:3014`

| Method | Path | Body field | Returns |
|--------|------|-----------|---------|
| `GET`  | `/health` | — | JSON status |
| `POST` | `/api/shipping/parse-labels-csv` | `file` (1 PDF) | CSV download |
| `POST` | `/api/shipping/parse-labels-csv-multi` | `files` (1–25 PDFs) | CSV download |
| `POST` | `/api/shipping/parse-labels` | `file` (1 PDF) | JSON (all labels) |
| `POST` | `/api/shipping/parse-label` | `file` (1 PDF) | JSON (first label) |

All uploads are `multipart/form-data`.

**Full request/response reference:** see [`API_DOCUMENTATION.md`](./API_DOCUMENTATION.md) — includes exact keys, error shapes, TypeScript interfaces, and `fetch` examples for the frontend.

---

