# Smart Query Node.js Service v3.0 — Upgrade Changelog

## 🚀 v2.0 → v3.0

### Installation
```bash
cd smart-query-node-v3
npm install    # installs 3 new deps: node-cache, node-cron, nodemailer
cp .env.example .env   # add your NVIDIA API key + SMTP config
npm run dev    # or: npm start
```

### New Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| `node-cache` | ^5.1.2 | LRU query cache with TTL |
| `node-cron` | ^3.0.3 | Scheduled report cron jobs |
| `nodemailer` | ^6.9.8 | Email delivery for reports |

---

## ✅ 5 Features Implemented

### Feature 1: Query Cache (LRU + TTL)
- **New file:** `src/services/queryCache.js`
- Hash-based cache key: `md5(question + module + filters)`
- Configurable TTL (default 600s) and max keys (default 200)
- Skips cache for follow-up queries (contextual)
- Cache stats exposed in `/status` endpoint
- `/cache/flush` endpoint to clear manually
- **Impact:** Saves 2–13s per repeated query + reduces NVIDIA API costs

### Feature 2: Follow-Up Context (Conversational Queries)
- **Modified:** `src/utils/promptBuilder.js`
- When `previousQuestion` + `previousSql` are sent, builds a contextual prompt
- Previous SQL is aliased back before sending to LLM (security: real names never exposed)
- LLM can modify/refine the previous SQL rather than generating from scratch
- Falls back to fresh generation if question is unrelated

### Feature 3: AI Explain (Natural Language Summary)
- **New file:** `src/services/explainService.js`
- **New endpoint:** `POST /explain`
- Sends top 20 rows + column info back to LLM with a summarize prompt
- Returns plain-English insight with **bold** highlights and bullet points
- Uses same NVIDIA primary + Ollama fallback pattern
- Token-efficient: compact table format for data preview

### Feature 4: SSE Streaming Pipeline
- **New endpoint:** `POST /ask-stream`
- **Modified:** `src/services/orchestrator.js` — new `processQueryStreaming()` function
- Emits Server-Sent Events as pipeline progresses:
  - `step` → pipeline step changes (1→2→3→4)
  - `sql_done` → generated SQL complete
  - `result` → final query results
  - `error` → pipeline failure
- Proper SSE headers + nginx buffering disabled
- Handles client disconnect gracefully

### Feature 5: Saved Dashboards + Scheduled Email Reports
- **New files:** `src/services/dashboardService.js`, `src/services/schedulerService.js`
- Auto-creates 3 PostgreSQL tables on first use:
  - `sq_dashboards` — dashboard metadata
  - `sq_dashboard_cards` — pinned query cards with chart config
  - `sq_scheduled_reports` — cron-scheduled email reports
- Full CRUD API for dashboards, cards, and reports
- `node-cron` runs scheduled queries at configured intervals
- `nodemailer` emails results as CSV attachments
- HTML email template with summary table
- "Run Now" endpoint for testing reports

---

## 📡 All API Endpoints (v3)

### Core Query
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ask` | NL-to-SQL query (+ cache + follow-up) |
| POST | `/ask-stream` | SSE streaming pipeline |
| POST | `/explain` | AI natural language summary |
| POST | `/export-csv` | CSV file download |
| GET | `/status` | Service health + cache stats |

### Cache
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/cache/flush` | Clear all cached queries |

### Dashboards
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboards` | List user's dashboards |
| POST | `/dashboards` | Create dashboard |
| GET | `/dashboards/:id` | Get dashboard + cards |
| DELETE | `/dashboards/:id` | Delete dashboard |
| POST | `/dashboards/:id/cards` | Add query card |
| DELETE | `/cards/:id` | Remove card |

### Scheduled Reports
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/scheduled-reports` | List reports |
| POST | `/scheduled-reports` | Create report |
| PUT | `/scheduled-reports/:id` | Update report |
| DELETE | `/scheduled-reports/:id` | Delete report |
| POST | `/scheduled-reports/:id/run-now` | Execute immediately |

### System
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/actuator/health` | Health check |

---

## 🔧 .env Configuration (new sections)

```env
# Query Cache
CACHE_ENABLED=true
CACHE_TTL_SECONDS=600
CACHE_MAX_KEYS=200

# SMTP (for scheduled reports)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@gmail.com
SMTP_PASSWORD=your_app_password
SMTP_FROM=KMC Smart Query <smartquery@kmc.gov.in>

# Scheduler
SCHEDULER_ENABLED=false    # set to true when SMTP is configured
```

---

## 🧪 Testing
```bash
# Start the service first
npm start

# In another terminal
npm test    # runs src/test/apiTest.js — tests all 13 endpoints
```
