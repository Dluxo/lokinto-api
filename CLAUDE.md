# GigBot — Project Memory

## What This Is
GigBot is a Telegram-based AI career agent for product designers. It finds jobs, generates tailored CVs, manages leads, and builds portfolio websites from uploaded case study PDFs.

---

## Case Study Upload Pipeline

When a user uploads a PDF and selects **🎨 Case Study**:

### 1. Download & Hash
- PDF is downloaded from Telegram
- SHA-256 hash computed → checked against existing `WorkItem.fileHash` to detect duplicates
- If duplicate found → user warned immediately, processing stops

### 2. Extract Content
- **Text**: `extractTextFromPDF(buffer)` → plain text via `pdf-parse`
- **Pages**: `extractPDFPages(buffer, 10)` → up to 10 PNG screenshots at scale 0.75

### 3. Archive Screenshots (download only, NOT displayed)
- `saveCaseStudyImages()` saves PNGs to:
  `public/uploads/{userId}/{slug}/pages/page-{n}.png`
- These are **never shown on the case study page** — only archived for future download
- The base URL for the pages folder is stored in `WorkItem.imageUrl`

### 4. Claude Vision Extraction
- All page screenshots sent to Claude as base64 vision inputs
- Claude reads the actual visual content (text, diagrams, metrics)
- Claude outputs structured JSON with these section types ONLY:
  - `{ type: "heading", text: "..." }` — section title
  - `{ type: "paragraph", text: "..." }` — full paragraph of real content
  - `{ type: "stats", items: [{ value: "40%", label: "drop-off" }] }` — metrics
  - **NO image sections** — screenshots are not embedded in the page

### 5. Save content.md
- `saveCaseStudyContent()` writes a human-readable markdown file to:
  `public/uploads/{userId}/{slug}/content.md`
- This is the canonical readable source for the work item

### 6. Save to Database
- `WorkItem` created with:
  - `title`, `role`, `tools`, `outcome`, `tags` — from Claude's JSON
  - `description` — first paragraph section (used for card previews)
  - `sectionsJson` — full sections array as JSON string
  - `fileHash` — SHA-256 for duplicate detection
  - `imageUrl` — URL prefix to the archived pages folder

---

## Case Study Page Rendering

Route: `GET /p/:slug/work/:workId`

- Reads `WorkItem` from DB by ID
- Calls `generateProjectPage(workItem, portfolioSlug)`
- Parses `sectionsJson` into sections array
- Renders `src/templates/project.html` with sections
- Page renders **text only** — headings, paragraphs, stats blocks
- No PDF screenshots shown — content comes from the extracted text

---

## Portfolio Generation

- Command: `generate portfolio for [role] at [company]`
- Pulls all `WorkItem` records for the user
- Passes to Claude with job description → Claude tailors content + ordering
- Claude returns structured JSON → rendered into `src/templates/portfolio.html`
- Saved to `Portfolio` table with a unique slug
- Served at `GET /p/:slug`
- Each work item card links to `/p/:slug/work/:id`

---

## Key Files

| File | Purpose |
|---|---|
| `src/bot/handler.ts` | Telegram webhook handler, PDF upload logic |
| `src/bot/router.ts` | Intent routing, portfolio generation command |
| `src/actions/cvParser.ts` | PDF text + page screenshot extraction |
| `src/actions/portfolioGenerator.ts` | HTML generation, content.md saving, screenshot archiving |
| `src/templates/portfolio.html` | Portfolio index page template |
| `src/templates/project.html` | Case study detail page template |
| `src/db/portfolio.ts` | WorkItem + Portfolio DB queries |
| `src/db/cv.ts` | UserCV DB queries |
| `prisma/schema.prisma` | DB schema |
| `src/scripts/gen-preview.ts` | Regenerates `/p/preview` with real work items |

---

## Running Locally

```bash
# Terminal 1 — server
npm run dev

# Terminal 2 — ngrok tunnel (required for Telegram webhook)
ngrok http --domain=pa-subdilated-artfully.ngrok-free.dev 3000

# Regenerate preview portfolio
npx ts-node src/scripts/gen-preview.ts
```

Preview: `http://localhost:3000/p/preview`

---

## Database Models (key fields)

**WorkItem**
- `sectionsJson` — JSON array of page sections (heading/paragraph/stats)
- `fileHash` — SHA-256 for duplicate detection
- `imageUrl` — URL prefix to archived PDF pages folder

**UserCV**
- `fileHash` — SHA-256 for duplicate detection

**Portfolio**
- `htmlContent` — full rendered HTML stored in DB
- `slug` — unique URL slug
