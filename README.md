<h1 align="center">Xtract — Backend</h1>

<p align="center">
  A NestJS service that extracts structured bank-statement data from uploaded PDFs using AWS Textract for OCR and Google Gemini for AI normalization.
</p>

<!-- ─────────────────────────────────────────────────────────────
     📸  Add a screenshot / architecture diagram below.
     Drop an image into a `docs/` folder and update the path,
     or drag-and-drop directly into this section on GitHub.
     ───────────────────────────────────────────────────────────── -->

<p align="center">
  <!-- <img src="docs/screenshot.png" alt="Xtract backend" width="800" /> -->
  <em>Screenshot / architecture diagram coming soon</em>
</p>

---

## Overview

The Xtract backend is the processing engine behind the [Xtract](../Xtract) web app. It accepts a bank-statement PDF, runs it through an asynchronous, event-driven pipeline, and returns clean, structured JSON:

1. **Upload** — the PDF is stored in AWS S3 and an AWS Textract OCR job is started.
2. **Extract** — when Textract finishes, it notifies the service via an SNS webhook. The raw OCR text is pulled, then normalized by Google Gemini into a consistent schema (accounts, balances, transactions).
3. **Retrieve** — the result is saved to MongoDB against a `jobId`, which the client polls until the status is `COMPLETED`.

## Tech Stack

| Component            | Technology                                        |
| -------------------- | ------------------------------------------------- |
| Framework            | NestJS 11 (Express)                               |
| Language             | TypeScript 5.7                                     |
| File upload          | Multer (disk storage, `/tmp/uploads`, PDF ≤ 10 MB) |
| Object storage       | AWS S3 (`@aws-sdk/client-s3`)                      |
| PDF OCR              | AWS Textract (`@aws-sdk/client-textract`)          |
| Async notifications  | AWS SNS (webhook callbacks)                        |
| AI normalization     | Google Gemini 2.5 Flash (`@google/genai`)          |
| Database             | MongoDB via Mongoose (`@nestjs/mongoose`)          |
| Config               | `@nestjs/config` (global)                          |
| Package manager      | pnpm 10.28.2                                        |
| Container            | Docker (Node 20 Alpine, multi-stage, non-root)     |

## Architecture & Data Flow

```
 POST /upload (PDF)
      │  validate (pdf, ≤10MB) → upload to S3 → start Textract job
      │  store { jobId, status: PROCESSING } in MongoDB
      ▼
 { message, jobId, s3Key }                      ← returned immediately

 …AWS Textract runs OCR asynchronously…

 POST /notify (SNS webhook)
      │  confirm subscription (first call) → fetch OCR text (paginated LINE blocks)
      │  send text to Google Gemini → normalized BankStatement[] JSON
      ▼
 update MongoDB { data, status: COMPLETED }

 GET /:jobId  (client polls every ~2s)
      ▼
 { jobId, status, data }
```

## API Endpoints

All routes are registered at the root (no global prefix).

| Method | Endpoint  | Description                                | Request                                | Response                                                        |
| ------ | --------- | ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------- |
| `POST` | `/upload` | Upload a PDF and start extraction          | `multipart/form-data` → `file` (PDF ≤ 10 MB) | `{ message, jobId, s3Key }`                              |
| `POST` | `/notify` | SNS webhook for Textract completion        | Raw SNS JSON body                       | `Subscription confirmed` / `Message received` / `OK`           |
| `GET`  | `/:jobId` | Fetch extraction result by job ID          | URL param `jobId`                       | `{ jobId, status: PROCESSING\|COMPLETED\|FAILED, data: BankStatement[] }` |
| `GET`  | `/test`   | Health check                               | —                                       | `{ message: "Hello" }`                                          |

**`POST /upload`** — only `application/pdf` is accepted (max 10 MB). Returns `400` if the file is missing or not a PDF, `500` on an S3/Textract failure.

**`GET /:jobId`** — returns `400` for an empty `jobId` and `404` if the job is not found.

## Data Model

- **`ExtractedDocument`** — `jobId` (unique), `data: BankStatement[]`, `status` (`PROCESSING` \| `COMPLETED` \| `FAILED`), timestamps.
- **`BankStatement`** — `fileName`, `bankName`, `accountHolderName`, `accountNumber`, `accountType`, `currency` (default `INR`), `statementStartDate`, `statementEndDate`, `openingBalance`, `closingBalance`, `transactions[]`.
- **`Transaction`** — `date`, `description`, `debitAmount`, `creditAmount`, `runningBalance`.

## Environment Variables

Create a `.env` file in the project root:

| Variable          | Purpose                                        |
| ----------------- | ---------------------------------------------- |
| `MONGODB_URI`     | MongoDB connection string                      |
| `S3_BUCKET_NAME`  | AWS S3 bucket for PDF uploads                  |
| `ACCESS_KEY`      | AWS access key ID                              |
| `SECRET_KEY`      | AWS secret access key                          |
| `REGION`          | AWS region (e.g. `us-east-1`)                  |
| `ROLE_ARN`        | IAM role ARN Textract uses to publish to SNS   |
| `SNS_TOPIC_ARN`   | SNS topic ARN for Textract notifications       |
| `GEMINI_API_KEY`  | Google Gemini API key                          |

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 10.28.2
- A MongoDB instance
- AWS credentials with access to S3, Textract, SNS, and an IAM role
- A Google Gemini API key

### Install

```bash
pnpm install
```

### Run

```bash
# development (watch mode)
pnpm run start:dev

# production
pnpm run build
pnpm run start:prod
```

The server listens on **http://localhost:3001**.

### Docker

```bash
docker build -t xtract-backend .
docker run -p 3001:3001 --env-file .env xtract-backend
```

## Tests

```bash
pnpm run test        # unit tests
pnpm run test:e2e    # end-to-end tests
pnpm run test:cov    # coverage
```

## CI/CD

A GitHub Actions workflow (`.github/workflows/workflow.yml`) runs on push to `master`:

1. **Test** — install with `pnpm i --frozen-lockfile`, run `pnpm run test`, then `pnpm run build`.
2. **Build & Push** — build the multi-stage Docker image and push to Docker Hub.
3. **Deploy** — SSH into the VM and restart the container via Docker Compose, cleaning up dangling images.

## Notes

- The pipeline is fully asynchronous: `/upload` returns a `jobId` immediately; extraction completes later when Textract calls `/notify`. Clients track progress by polling `GET /:jobId`.
- SNS webhook bodies are received as raw text (`app.useBodyParser('text')`) and parsed manually; CORS is enabled.
- Gemini (`gemini-2.5-flash`) is prompted to normalize inconsistent labels, parse flexible date/currency formats, split debit/credit columns, and return strict JSON matching the `BankStatement[]` schema.
