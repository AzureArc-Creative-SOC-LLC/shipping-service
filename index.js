const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Pool } = require('pg');
const { createDomainMiddleware } = require('./domainMiddleware');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const { spawn } = require('child_process');
const os = require('os');

const dotenvCandidates = [
  process.env.DOTENV_PATH,
  // Local .env sitting next to this file (shipping-service/.env)
  path.resolve(__dirname, '.env'),
  // Shared env one level up: /var/www/.env when service is /var/www/shipping-service
  path.resolve(__dirname, '..', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
  // Shared backend env: /var/www/backend/.env when service is /var/www/backend/server/shipping-service/src
  path.resolve(__dirname, '..', '..', '..', '.env'),
].filter(Boolean);

let loadedDotenvPath = '';

for (const p of dotenvCandidates) {
  try {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      loadedDotenvPath = p;
      break;
    }
  } catch {
    // ignore
  }
}

function countTrackingCandidates(text) {
  const t = String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!t) return 0;
  const re = /\b([A-Z0-9]{2}\s?[0-9]{4}\s?[0-9]{4}\s?[0-9I][A-Z]{2,3})\b/g;
  let c = 0;
  while (re.exec(t)) c += 1;
  return c;
}

async function mergePdfBuffers(buffers) {
  const list = (Array.isArray(buffers) ? buffers : []).filter((b) => b && Buffer.isBuffer(b) && b.length);
  if (!list.length) return Buffer.alloc(0);
  if (list.length === 1) return list[0];

  const merged = await PDFDocument.create();
  for (const buf of list) {
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  const out = await merged.save();
  return Buffer.from(out);
}

function runCommandCapture(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      return reject(new Error(`${cmd} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function tryOcrMyPdfToText(inputPdfPath) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shipping-ocr-'));
  const ocrPdfPath = path.join(tmpDir, 'ocr.pdf');
  const sidecarPath = path.join(tmpDir, 'ocr.txt');

  try {
    await runCommandCapture('ocrmypdf', ['--version'], { cwd: tmpDir });
  } catch (e) {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return { ok: false, text: '', error: `ocrmypdf not available: ${e?.message || String(e)}` };
  }

  try {
    await runCommandCapture(
      'ocrmypdf',
      [
        '--force-ocr',
        '--rotate-pages',
        '--deskew',
        '--optimize',
        '1',
        '--language',
        'eng',
        '--tesseract-pagesegmode',
        '6',
        '--sidecar',
        sidecarPath,
        inputPdfPath,
        ocrPdfPath,
      ],
      { cwd: tmpDir }
    );

    const text = String(await fs.promises.readFile(sidecarPath, 'utf8')).trim();
    return { ok: true, text, error: '' };
  } catch (e) {
    return { ok: false, text: '', error: e?.message || String(e) };
  } finally {
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function isExtractionWeak(extracted) {
  const list = Array.isArray(extracted) ? extracted : [];
  if (!list.length) return true;
  let missingRecipient = 0;
  let missingPostcode = 0;
  for (const x of list) {
    if (!String(x?.recipient_name || '').trim()) missingRecipient += 1;
    if (!String(x?.postcode || '').trim()) missingPostcode += 1;
  }
  return missingRecipient / list.length > 0.5 || missingPostcode / list.length > 0.5;
}

console.log(
  `[shipping-service] dotenv loaded: ${loadedDotenvPath || 'NONE'} (candidates: ${dotenvCandidates.join(', ')})`
);

function getDbConfig() {
  const connectionString = process.env.DATABASE_URL || process.env.DB_URL || '';
  if (connectionString) {
    return { connectionString };
  }

  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || '',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || '',
  };
}

const dbConfig = getDbConfig();

console.log(
  `[shipping-service] db env: DATABASE_URL=${process.env.DATABASE_URL ? 'set' : 'missing'}, DB_URL=${process.env.DB_URL ? 'set' : 'missing'}, DB_HOST=${process.env.DB_HOST ? 'set' : 'missing'}, DB_NAME=${process.env.DB_NAME ? 'set' : 'missing'}`
);

const pool = new Pool({
  ...dbConfig,
  max: 10,
  ssl: {
    rejectUnauthorized: false,
  },
});

const domainMiddleware = createDomainMiddleware({
  lookupDomain: async (name) => {
    const { rows } = await pool.query('SELECT id, status FROM domains WHERE domain_name = $1', [name]);
    return rows[0] || null;
  },
});

async function ensureTables() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS shipping_labels (
      id SERIAL PRIMARY KEY,
      tracking_number VARCHAR(40),
      customer_ref VARCHAR(80),
      recipient_name VARCHAR(160),
      address_text TEXT,
      postcode VARCHAR(20),
      service_name VARCHAR(80),
      postage_cost DECIMAL(10,2),
      postage_currency VARCHAR(10),
      label_date VARCHAR(40),
      source_filename VARCHAR(255),
      raw_text TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT uniq_tracking_number UNIQUE (tracking_number)
    );`
  );
}

function normalizeTracking(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s;
}

function normalizePostcode(raw) {
  const s = String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim();
  return s;
}

function buildLoosePostcodeRegex(postcode) {
  const compact = String(postcode || '').toUpperCase().replace(/\s+/g, '');
  if (!compact) return null;
  const escaped = compact.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const pattern = escaped.split('').join('\\s*');
  return new RegExp(`\\b${pattern}\\b`, 'i');
}

function isNoiseRecipientLine(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  if (/^royal\s*mail\b/i.test(s)) return true;
  if (/carbon\s*footprint/i.test(s)) return true;
  if (/\bUK'?s\b/i.test(s) && /carbon/i.test(s)) return true;
  if (/\btracked\s*(24|48)\b/i.test(s)) return true;
  if (/\bcustomer\s*ref\b/i.test(s)) return true;
  if (/\bpostage\s*cost\b/i.test(s)) return true;
  if (/\bpost\s*by\b/i.test(s)) return true;
  return false;
}

function parseRecipientFromLines(lines, postcode) {
  const safeLines = (Array.isArray(lines) ? lines : [])
    .map((l) => String(l || '').trim())
    .filter((l) => l);

  const postcodeIdx = (() => {
    if (!postcode) return -1;
    const loose = buildLoosePostcodeRegex(postcode);
    if (loose) {
      const idx = safeLines.findIndex((l) => loose.test(l));
      if (idx >= 0) return idx;
    }
    return safeLines.findIndex((l) => new RegExp(`\\b${postcode.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&')}\\b`, 'i').test(l));
  })();

  const endExclusive = postcodeIdx >= 0 ? postcodeIdx + 1 : safeLines.length;
  const start = Math.max(0, endExclusive - 9);
  const blockRaw = safeLines.slice(start, endExclusive);
  const block = blockRaw.filter((l) => !isNoiseRecipientLine(l));
  if (!block.length) return { recipient_name: '', address_text: '' };

  // Sometimes the first address line includes name + address in one line: "John Doe, 12 Some Street"
  // Prefer the first line without digits as the name.
  let recipient_name = '';
  let addressParts = [];

  for (let i = 0; i < block.length; i++) {
    const l = block[i];

    // If a line contains a comma and the left side looks like a name, split it.
    const commaIdx = l.indexOf(',');
    if (commaIdx > 0) {
      const left = l.slice(0, commaIdx).trim();
      const right = l.slice(commaIdx + 1).trim();
      const leftLooksLikeName = left && !/\d/.test(left) && left.length <= 60;
      if (!recipient_name && leftLooksLikeName) {
        recipient_name = left;
        if (right) addressParts.push(right);
        continue;
      }
    }

    const looksLikeName = l && !/\d/.test(l) && l.length <= 60;
    if (!recipient_name && looksLikeName) {
      recipient_name = l;
      continue;
    }

    addressParts.push(l);
  }

  // Ensure postcode is included at end of address.
  const address_text = addressParts.filter(Boolean).join(', ');
  return { recipient_name, address_text };
}

function findPostcodeInLines(lines) {
  const re = /\b([A-Z]{1,2}[0-9O]{1,2}[A-Z]?\s*[0-9O][A-Z]{2})\b/i;
  const safeLines = (Array.isArray(lines) ? lines : []).map((l) => String(l || '').trim());
  for (let i = safeLines.length - 1; i >= 0; i--) {
    const l = safeLines[i];
    if (!l || isNoiseRecipientLine(l)) continue;
    const m = l.match(re);
    if (m && m[1]) {
      return { postcode: normalizePostcode(m[1]), index: i };
    }
  }

  const joined = safeLines.join(' ');
  const m2 = joined.match(re);
  if (m2 && m2[1]) {
    return { postcode: normalizePostcode(m2[1]), index: -1 };
  }
  return { postcode: '', index: -1 };
}

function extractFieldsFromText(text) {
  const t = String(text || '');

  // Royal Mail tracking format often looks like: MV 0979 7959 1GB
  const trackingRe = /\b([A-Z]{2}\s?\d{4}\s?\d{4}\s?\d[A-Z]{2,3})\b/;
  const trackingExec = trackingRe.exec(t);
  const tracking_number = normalizeTracking(trackingExec ? trackingExec[1] : '');

  // Focus recipient parsing on the region that contains the destination block.
  // NOTE: In some PDFs the extracted text order places the destination address BEFORE the tracking number,
  // so we must include content before tracking. We still stop at "Customer Ref" to avoid footer/return text.
  const customerRefIdx = t.search(/Customer\s*Ref/i);
  const recipientSegment = t.slice(0, customerRefIdx > 0 ? customerRefIdx : t.length).trim();

  const customerRefMatch = t.match(/Customer\s*Ref\s*:?\s*([A-Za-z0-9-]{1,40})/i);
  const customer_ref = customerRefMatch ? String(customerRefMatch[1]).trim() : '';

  let postcode = '';

  // Service name (e.g. Tracked 24) often appears near top
  const serviceMatch = t.match(/\bTracked\s*(24|48)\b/i);
  const service_name = serviceMatch ? `Tracked ${serviceMatch[1]}` : '';

  const costMatch = t.match(/Postage\s*Cost\s*£\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
  const postage_cost = costMatch ? Number(costMatch[1]) : null;
  const postage_currency = costMatch ? 'GBP' : null;

  const dateMatch = t.match(/Post\s*by\s*end\s*of\s*(\d{2}\.\d{2}\.\d{4})/i);
  const label_date = dateMatch ? String(dateMatch[1]).trim() : '';

  // Recipient block: best-effort.
  // If we find a postcode, take up to ~4 lines before it as name/address.
  let recipient_name = '';
  let address_text = '';

  const lines = recipientSegment
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l);

  const found = findPostcodeInLines(lines);
  postcode = found.postcode || '';

  if (postcode) {
    const parsedRecipient = parseRecipientFromLines(lines, postcode);
    recipient_name = parsedRecipient.recipient_name || '';
    address_text = parsedRecipient.address_text || '';
  }

  return {
    tracking_number: tracking_number || null,
    customer_ref: customer_ref || null,
    recipient_name: recipient_name || null,
    address_text: address_text || null,
    postcode: postcode || null,
    service_name: service_name || null,
    postage_cost: Number.isFinite(postage_cost) ? postage_cost : null,
    postage_currency: postage_currency || null,
    label_date: label_date || null,
  };
}

function splitLabelsFromText(text) {
  const t = String(text || '');
  const re = /\b([A-Z]{2}\s?\d{4}\s?\d{4}\s?\d[A-Z]{2,3})\b/g;
  const matches = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    matches.push({ index: m.index, tracking: normalizeTracking(m[1]) });
  }

  if (matches.length <= 1) return [t];

  const chunks = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : t.length;
    const chunk = t.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks.length ? chunks : [t];
}

async function upsertShippingLabel(fields, rawText, sourceFilename, domainId) {
  await pool.query(
    `INSERT INTO shipping_labels (
      tracking_number, customer_ref, recipient_name, address_text, postcode,
      service_name, postage_cost, postage_currency, label_date,
      source_filename, raw_text, domain_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (tracking_number) DO UPDATE SET
      customer_ref = EXCLUDED.customer_ref,
      recipient_name = EXCLUDED.recipient_name,
      address_text = EXCLUDED.address_text,
      postcode = EXCLUDED.postcode,
      service_name = EXCLUDED.service_name,
      postage_cost = EXCLUDED.postage_cost,
      postage_currency = EXCLUDED.postage_currency,
      label_date = EXCLUDED.label_date,
      source_filename = EXCLUDED.source_filename,
      raw_text = EXCLUDED.raw_text`,
    [
      fields.tracking_number,
      fields.customer_ref,
      fields.recipient_name,
      fields.address_text,
      fields.postcode,
      fields.service_name,
      fields.postage_cost,
      fields.postage_currency,
      fields.label_date,
      sourceFilename || null,
      rawText || null,
      domainId ?? null,
    ]
  );

  if (!fields.tracking_number) return null;

  const { rows } = await pool.query('SELECT * FROM shipping_labels WHERE tracking_number = $1 LIMIT 1', [fields.tracking_number]);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

function sanitizeBaseFilename(name) {
  const raw = String(name || '').trim();
  const base = raw.replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'labels';
}

function buildCsvFromExtracted(extracted) {
  const escapeCsv = (value) => {
    const s = String(value ?? '');
    if (/[\n\r",]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const header = ['Full Name', 'Postal Code', 'Tracking Number'];
  const lines = [header.join(',')];

  for (const x of extracted) {
    lines.push(
      [
        escapeCsv(x?.recipient_name || ''),
        escapeCsv(x?.postcode || ''),
        escapeCsv(x?.tracking_number || ''),
      ].join(',')
    );
  }

  return `${lines.join('\n')}\n`;
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function pickUniqueBaseName(dir, base) {
  const cleanedBase = sanitizeBaseFilename(base);
  let candidate = cleanedBase;
  let i = 1;
  while (true) {
    const pdfPath = path.join(dir, `${candidate}.pdf`);
    try {
      await fs.promises.access(pdfPath, fs.constants.F_OK);
      i += 1;
      candidate = `${cleanedBase}-${i}`;
    } catch {
      return candidate;
    }
  }
}

const app = express();

const PORT = Number(process.env.SHIPPING_SERVICE_PORT || process.env.PORT || 3014);
const corsOrigin = process.env.CORS_ORIGIN || '*';

app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()).filter(Boolean), credentials: true }));
app.use(helmet());
app.use(morgan('dev'));
app.use(domainMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'shipping-service', timestamp: new Date() });
});

app.get('/api/shipping/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'shipping-service', timestamp: new Date() });
});

app.post('/api/shipping/parse-labels-csv', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'file is required (multipart form-data field name: file)' });

    const labelsRoot = String(process.env.LABELS_DIR || '/var/www/backend/labels');
    const pdfDir = path.join(labelsRoot, 'pdf');
    const csvDir = path.join(labelsRoot, 'csv');
    await ensureDir(pdfDir);
    await ensureDir(csvDir);

    const finalBase = await pickUniqueBaseName(pdfDir, file.originalname || 'labels');

    const pdfFileName = `${finalBase}.pdf`;
    const csvFileName = `${finalBase}.csv`;
    const pdfPath = path.join(pdfDir, pdfFileName);
    const csvPath = path.join(csvDir, csvFileName);

    await fs.promises.writeFile(pdfPath, file.buffer);

    let text = '';
    try {
      const parsed = await pdfParse(file.buffer);
      text = String(parsed?.text || '').trim();
    } catch {
      text = '';
    }

    let chunks = [];
    let extracted = [];
    let saved = [];

    if (text) {
      chunks = splitLabelsFromText(text);
    }

    const initialExtracted = Array.isArray(chunks) && chunks.length
      ? chunks.map((chunk) => extractFieldsFromText(chunk))
      : [];

    const shouldTryOcr = !text || isExtractionWeak(initialExtracted);
    let usedOcr = false;

    if (shouldTryOcr) {
      const ocr = await tryOcrMyPdfToText(pdfPath);
      if (!ocr.ok || !ocr.text) {
        if (!text) {
          return res.status(422).json({
            error: ocr.error
              ? `No text could be extracted and OCR failed: ${ocr.error}`
              : 'No text could be extracted from the PDF. This PDF might be image-only and require OCR.',
          });
        }
      } else {
        text = ocr.text;
        chunks = splitLabelsFromText(text);
        usedOcr = true;
      }
    }

    if (!Array.isArray(chunks) || chunks.length === 0) {
      chunks = text ? [text] : [];
    }

    console.log(
      `[shipping-service] parse-labels-csv: file=${pdfFileName} textLen=${String(text || '').length} chunks=${chunks.length} usedOcr=${usedOcr}`
    );
    console.log(
      `[shipping-service] parse-labels-csv: trackingCandidates=${countTrackingCandidates(text)}`
    );

    // Persist rows + build extracted rows from the final text chunks we ended up with.
    extracted = [];
    saved = [];
    for (const chunk of chunks) {
      const fields = extractFieldsFromText(chunk);
      extracted.push(fields);
      const row = await upsertShippingLabel(fields, chunk, pdfFileName, req.domainId);
      saved.push(row);
    }

    console.log(
      `[shipping-service] parse-labels-csv: extractedRows=${extracted.length} nonEmptyTracking=${extracted.filter((x) => String(x?.tracking_number || '').trim()).length}`
    );

    const csv = buildCsvFromExtracted(extracted);
    await fs.promises.writeFile(csvPath, csv, 'utf8');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFileName}"`);
    return res.status(200).send(csv);
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to parse label' });
  }
});

app.post('/api/shipping/parse-labels-csv-multi', upload.array('files', 25), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: 'files are required (multipart form-data field name: files)' });

    const mergedBuffer = await mergePdfBuffers(files.map((f) => f?.buffer).filter(Boolean));
    if (!mergedBuffer || !mergedBuffer.length) {
      return res.status(422).json({ error: 'Failed to merge PDFs (empty output)' });
    }

    const labelsRoot = String(process.env.LABELS_DIR || '/var/www/backend/labels');
    const pdfDir = path.join(labelsRoot, 'pdf');
    const csvDir = path.join(labelsRoot, 'csv');
    await ensureDir(pdfDir);
    await ensureDir(csvDir);

    const mergedName = `merged-${Date.now()}.pdf`;
    const finalBase = await pickUniqueBaseName(pdfDir, mergedName);

    const pdfFileName = `${finalBase}.pdf`;
    const csvFileName = `${finalBase}.csv`;
    const pdfPath = path.join(pdfDir, pdfFileName);
    const csvPath = path.join(csvDir, csvFileName);

    await fs.promises.writeFile(pdfPath, mergedBuffer);

    let text = '';
    try {
      const parsed = await pdfParse(mergedBuffer);
      text = String(parsed?.text || '').trim();
    } catch {
      text = '';
    }

    let chunks = [];
    let extracted = [];
    let saved = [];

    if (text) {
      chunks = splitLabelsFromText(text);
    }

    const initialExtracted = Array.isArray(chunks) && chunks.length ? chunks.map((chunk) => extractFieldsFromText(chunk)) : [];
    const shouldTryOcr = !text || isExtractionWeak(initialExtracted);
    let usedOcr = false;

    if (shouldTryOcr) {
      const ocr = await tryOcrMyPdfToText(pdfPath);
      if (!ocr.ok || !ocr.text) {
        if (!text) {
          return res.status(422).json({
            error: ocr.error
              ? `No text could be extracted and OCR failed: ${ocr.error}`
              : 'No text could be extracted from the PDF. This PDF might be image-only and require OCR.',
          });
        }
      } else {
        text = ocr.text;
        chunks = splitLabelsFromText(text);
        usedOcr = true;
      }
    }

    if (!Array.isArray(chunks) || chunks.length === 0) {
      chunks = text ? [text] : [];
    }

    console.log(
      `[shipping-service] parse-labels-csv-multi: pdf=${pdfFileName} mergedFiles=${files.length} textLen=${String(text || '').length} chunks=${chunks.length} usedOcr=${usedOcr}`
    );
    console.log(`[shipping-service] parse-labels-csv-multi: trackingCandidates=${countTrackingCandidates(text)}`);

    extracted = [];
    saved = [];
    for (const chunk of chunks) {
      const fields = extractFieldsFromText(chunk);
      extracted.push(fields);
      const row = await upsertShippingLabel(fields, chunk, pdfFileName, req.domainId);
      if (row) saved.push(row);
    }

    const csv = buildCsvFromExtracted(extracted);
    await fs.promises.writeFile(csvPath, csv);

    const nonEmptyTracking = extracted.filter((x) => String(x?.tracking_number || '').trim()).length;
    console.log(
      `[shipping-service] parse-labels-csv-multi: extractedRows=${extracted.length} nonEmptyTracking=${nonEmptyTracking}`
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFileName}"`);
    return res.send(csv);
  } catch (e) {
    console.error('[shipping-service] parse-labels-csv-multi error:', e);
    return res.status(500).json({ error: e?.message || 'Failed to parse labels' });
  }
});

app.post('/api/shipping/parse-labels', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'file is required (multipart form-data field name: file)' });

    const parsed = await pdfParse(file.buffer);
    const text = String(parsed?.text || '').trim();

    if (!text) {
      return res.status(422).json({
        error: 'No text could be extracted from the PDF. This PDF might be image-only and require OCR.',
      });
    }

    const chunks = splitLabelsFromText(text);
    const extracted = [];
    const saved = [];

    for (const chunk of chunks) {
      const fields = extractFieldsFromText(chunk);
      extracted.push(fields);
      const row = await upsertShippingLabel(fields, chunk, file.originalname || null, req.domainId);
      saved.push(row);
    }

    return res.json({ success: true, count: extracted.length, extracted, saved });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to parse label' });
  }
});

app.post('/api/shipping/parse-label', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'file is required (multipart form-data field name: file)' });

    const parsed = await pdfParse(file.buffer);
    const text = String(parsed?.text || '').trim();

    if (!text) {
      return res.status(422).json({
        error: 'No text could be extracted from the PDF. This PDF might be image-only and require OCR.',
      });
    }

    const chunk = splitLabelsFromText(text)[0] || '';
    const fields = extractFieldsFromText(chunk);
    const row = await upsertShippingLabel(fields, chunk, file.originalname || null, req.domainId);

    return res.json({ success: true, extracted: fields, saved: row });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Failed to parse label' });
  }
});

(async () => {
  try {
    await ensureTables();
    app.listen(PORT, () => {
      console.log(`[shipping-service] running on port ${PORT}`);
    });
  } catch (e) {
    console.error('[shipping-service] failed to start:', e);
    process.exit(1);
  }
})();