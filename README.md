# Smart Query — Backend Service

> AI-powered Natural Language to SQL engine for KMC ERP (Market & Engineering modules)

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green) ![Express](https://img.shields.io/badge/Express-4.x-lightgrey) ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-blue) ![LLM](https://img.shields.io/badge/LLM-NVIDIA%20NIM%20%7C%20Ollama-orange)

---

## Overview

Smart Query Backend is a Node.js/Express service that translates plain-English questions into SQL queries against KMC's ERP database. It uses a RAG (Retrieval-Augmented Generation) pipeline with few-shot examples and live schema context to produce accurate, module-aware SQL — then executes it and returns structured results to the frontend.

It supports two ERP modules out of the box:
- **Market** — sales orders, customers, inventory, billing
- **Engineering** — projects, BOMs, work orders, asset tracking

---

## Architecture

```
User Question (NL)
        │
        ▼
  PromptBuilder           ← schema context + few-shot examples + alias map
        │
        ▼
  LLM Service             ← NVIDIA NIM (primary) or Ollama (fallback)
        │
        ▼
  SQL Validator           ← safety checks, read-only enforcement
        │
        ▼
  PostgreSQL              ← live ERP database
        │
        ▼
  Orchestrator            ← formats results, detects chart type, streams response
        │
        ▼
  REST API → Frontend
```

---

## Features

| Feature | Description |
|---|---|
| NL-to-SQL | Converts plain English to PostgreSQL via LLM + RAG |
| Few-shot RAG | Module-specific example bank for high accuracy |
| Schema Discovery | Auto-discovers tables, columns, and relationships |
| Schema Snapshots | Cached JSON snapshots for fast prompt building |
| Streaming Response | Server-Sent Events for real-time SQL preview |
| Chart Detection | Auto-detects best chart type (bar, line, pie, etc.) |
| Query Cache | In-memory cache to avoid redundant LLM calls |
| PDF Export | Generates formatted PDF reports with letterhead |
| Follow-up Queries | Maintains session context for multi-turn queries |
| Feedback Capture | Thumbs up/down per query for continuous improvement |
| Query History | Persists recent queries per user/module |
| Scheduler | Background jobs for cache refresh and cleanup |
| Niyantrak | Governance layer — RBAC, audit log, action queue |
| Service Status | Health endpoints for all connected services |

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Framework:** Express 4.x
- **Database:** PostgreSQL 14+
- **LLM Providers:** NVIDIA NIM, Ollama
- **PDF Generation:** PDFKit
- **Streaming:** Server-Sent Events (SSE)
- **Schema Cache:** In-memory + JSON snapshot files

---

## Project Structure

```
src/
├── app.js                          # Express entry point
├── config/
│   └── governance.yaml             # RBAC and governance rules
├── migrations/
│   ├── 001_niyantrak_runs.sql
│   ├── 002_niyantrak_audit.sql
│   └── 003_niyantrak_action_queue.sql
├── resources/
│   └── smartquery/
│       ├── market/
│       │   ├── few_shot_examples.json
│       │   └── schema_snapshots/
│       └── engineering/
│           └── schema_snapshots/
└── services/
    ├── orchestrator.js             # Main pipeline coordinator
    ├── nvidiaLlmService.js         # NVIDIA NIM integration
    ├── ollamaLlmService.js         # Ollama integration
    ├── schemaCacheService.js       # Schema caching
    ├── schemaDiscoveryService.js   # Live schema introspection
    ├── queryCache.js               # Query result cache
    ├── pdfService.js               # PDF report generation
    ├── dashboardService.js         # Service health dashboard
    ├── explainService.js           # Query explanation
    ├── feedbackService.js          # User feedback capture
    ├── schedulerService.js         # Background jobs
    └── niyantrak/
        ├── governance.js           # RBAC enforcement
        └── auditLog.js             # Audit trail
```

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ (KMC ERP database access)
- One of: NVIDIA NIM API key **or** Ollama running locally

---

## Setup & Run

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your DB credentials and LLM endpoint

# 3. Run database migrations
node src/migrations/runMigrations.js

# 4. Start the server
npm run dev       # development (nodemon)
npm start         # production
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | API server port (default: 3001) |
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port |
| `DB_NAME` | Database name |
| `DB_USER` | Database user |
| `DB_PASSWORD` | Database password |
| `LLM_PROVIDER` | `nvidia` or `ollama` |
| `NVIDIA_API_KEY` | NVIDIA NIM API key |
| `NVIDIA_MODEL` | Model name (e.g. `meta/llama-3.1-70b-instruct`) |
| `OLLAMA_BASE_URL` | Ollama base URL (default: `http://localhost:11434`) |
| `OLLAMA_MODEL` | Ollama model name |

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/query` | Submit NL query, returns SQL + results |
| `POST` | `/api/query/stream` | Streaming SSE version |
| `POST` | `/api/followup` | Follow-up query in session context |
| `GET` | `/api/schema/:module` | Get schema for a module |
| `GET` | `/api/history` | Get recent query history |
| `POST` | `/api/feedback` | Submit query feedback |
| `GET` | `/api/export/pdf` | Export results as PDF |
| `GET` | `/api/status` | Service health check |

---

## License

Internal — KMC Engineering Team. Not for public distribution.
