# Nest Backend PDF Extractor — Application Flow

This is a **NestJS** backend that extracts structured data (bank statements) from
uploaded PDF files. It does **not** parse PDFs locally with a library like
`pdf-parse`. Instead it uses a cloud, event-driven pipeline:

**Upload → S3 → AWS Textract (async OCR) → SNS webhook → text assembly → Gemini AI normalization → MongoDB.**

---

## 1. Tech Stack

| Concern            | Technology                                            |
| ------------------ | ----------------------------------------------------- |
| Framework          | NestJS 11 (Express platform)                          |
| File upload        | Multer (`@nestjs/platform-express`, disk storage)     |
| Object storage     | AWS S3 (`@aws-sdk/client-s3`)                          |
| PDF text extraction| **AWS Textract** (`@aws-sdk/client-textract`) — OCR   |
| Async notification | AWS SNS (webhook callback into the app)               |
| AI normalization   | **Google Gemini** (`@google/genai`, `gemini-2.5-flash`)|
| Database           | MongoDB via Mongoose (`@nestjs/mongoose`)             |
| Config             | `@nestjs/config` (env vars, global)                   |

---

## 2. Project Structure

```
src/
├── main.ts                         # Bootstrap: create app, listen on :3001
├── app.module.ts                   # Root module (Config, Mongoose, BankStatement)
├── app.controller.ts / .service.ts # Default Nest scaffold (Hello World)
│
├── bank-statement/                 # Core feature module
│   ├── bank-statement.controller.ts    # HTTP routes (upload, notify, get)
│   ├── bank-statement.service.ts       # Orchestrates the whole pipeline
│   ├── bank-statement.module.ts        # Wires controller/service + imports AI & AWS
│   └── schema/
│       └── bank-statement.schema.ts    # Mongoose schemas (ExtractedDocument, BankStatement, Transaction)
│
├── aws/                            # AWS clients
│   ├── aws.service.ts                  # Constructs S3 + Textract clients
│   ├── aws.module.ts
│   └── prompt/
│       └── extractor-prompt.ts         # Gemini prompt template
│
└── ai/                            # Google Gemini client
    ├── ai.service.ts
    └── ai.module.ts
```

---

## 3. Bootstrap (`src/main.ts`)

```ts
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  abortOnError: false,
  cors: true,
});
app.useBodyParser('text');   // needed to receive raw SNS notification bodies as text
await app.listen(3001);
```

- CORS enabled, app listens on **port 3001**.
- `useBodyParser('text')` is important: AWS SNS posts its notification payload as
  raw text, which the `/notify` handler parses manually with `JSON.parse`.

### Root module (`src/app.module.ts`)
- `ConfigModule.forRoot({ isGlobal: true })` — loads env vars into `process.env`,
  exposes `ConfigService.get()` app-wide.
- `MongooseModule.forRootAsync(...)` — connects to MongoDB using `MONGODB_URI`.
- Imports `BankStatementModule` (the feature module).

---

## 4. HTTP Endpoints (`bank-statement.controller.ts`)

All routes are registered at the root (`@Controller()` with no prefix).

| Method | Path        | Purpose                                              |
| ------ | ----------- | ---------------------------------------------------- |
| POST   | `/upload`   | Upload a PDF; kicks off S3 upload + Textract job     |
| POST   | `/notify`   | SNS webhook — Textract calls back when OCR finishes  |
| GET    | `/test`     | Health check → `{ message: 'Hello' }`                |
| GET    | `/:jobId`   | Poll extraction status + result by `jobId`           |

### Upload guardrails (Multer config on `/upload`)
- **Storage**: disk storage at `/tmp/uploads`, filename = `file-<timestamp>-<rand><ext>`.
- **fileFilter**: rejects anything whose mimetype isn't `*/pdf` → `BadRequestException('Only PDF files are allowed')`.
- **limits**: max file size **10 MB**.

---

## 5. The Full Extraction Flow

The pipeline is **asynchronous and two-phased**: the upload request returns
immediately with a `jobId`, and the actual text result arrives later via the SNS
webhook. The client polls `GET /:jobId` to get the final data.

### Phase A — Upload (synchronous part)
`POST /upload` → `BankStatementService.handleUploadAndDocExtraction(file)`

1. **Validate** a file exists (else `BadRequestException`).
2. **Read** the temp file from disk into a buffer (`fs.readFileSync(file.path)`).
3. **Upload to S3** under key `uploads/<timestamp>~<originalname>`
   (`PutObjectCommand` via `awsClientService.getS3Client()`).
4. **Start Textract job** with `StartDocumentTextDetectionCommand`:
   - Points Textract at the S3 object (`DocumentLocation.S3Object`).
   - Provides a `NotificationChannel` (`ROLE_ARN` + `SNS_TOPIC_ARN`) so Textract
     publishes completion to SNS when done.
5. **Persist a tracking record** in MongoDB:
   `{ jobId, data: [], status: 'PROCESSING' }`.
6. **Delete** the local temp file (`fs.unlinkSync`).
7. **Return** `{ message, jobId, s3Key }` to the client.

> At this point extraction is still running on AWS. Nothing is extracted yet.

### Phase B — Notification / extraction (asynchronous part)
When Textract finishes, AWS SNS calls `POST /notify` →
`BankStatementService.handleNotification(body)`:

1. Parse the body (string → JSON if needed).
2. **Subscription confirmation**: if `body.Type === 'SubscriptionConfirmation'`,
   fetch the `SubscribeURL` to confirm the SNS subscription and return.
3. **Notification**: if `body.Type === 'Notification'`, parse `body.Message`:
   - **`Status === 'SUCCEEDED'`**:
     - Derive `fileName` from `DocumentLocation.S3ObjectName` (`split('~').pop()`).
     - Call `getDocText(jobId, fileName)` to pull and assemble the OCR text.
     - Update the Mongo record: `{ data, status: 'COMPLETED' }`.
   - **`Status === 'FAILED'`**: set record `status: 'FAILED'` and throw.

### Text assembly (`getDocText`, private)
1. **Paginate** through Textract results with `GetDocumentTextDetectionCommand`
   (`MaxResults: 1000`), looping while a `NextToken` exists — collecting all `Blocks`.
2. If any page returns `JobStatus === 'FAILED'`, mark the record failed and throw.
3. **Reconstruct text**: keep only blocks where `BlockType === 'LINE'`, map to
   `block.Text`, and `join('\n')` into the raw statement text.
4. Pass the raw text to `normalizeWithAI(text, fileName, jobId)`.

### AI normalization (`normalizeWithAI`, private)
1. Build a prompt via `BankStatementExtractor.getExtractionTemplate(rawText, fileName)`
   (`aws/prompt/extractor-prompt.ts`) — instructs the model to output a strict JSON
   array of bank-statement objects (dates as `YYYY-MM-DD`, numeric amounts,
   debit/credit separation, running balance, etc.).
2. Call Gemini: `aiClientService.getClient().models.generateContent({ model: 'gemini-2.5-flash', contents: prompt })`.
3. **Clean** the response (strip ```` ```json ```` / ```` ``` ```` markdown fences), then `JSON.parse`.
4. **Validate** it's a non-empty array (else mark record `FAILED` and throw).
5. Return the parsed `BankStatement[]`, which the caller writes into the Mongo record.

### Phase C — Retrieve result
`GET /:jobId` → `BankStatementService.getByJobId(jobId)`:
- Looks up the `ExtractedDocument` by `jobId`.
- Returns `{ jobId, status, data }` (404 if not found).
- The client polls this until `status` is `COMPLETED` (or `FAILED`).

---

## 6. Sequence Diagram

```
Client        NestApp            S3        Textract        SNS         Gemini      MongoDB
  |  POST /upload  |               |           |             |            |            |
  |--------------->|               |           |             |            |            |
  |               | PutObject ---->|           |             |            |            |
  |               | StartTextDetection ------->|             |            |            |
  |               | create {status:PROCESSING} ------------------------------------->|
  |<--{jobId,s3Key}|               |           |             |            |            |
  |               |               |           | (OCR runs)  |            |            |
  |               |               |           |----done---->|            |            |
  |               |  POST /notify (webhook) <---------------|            |            |
  |               | GetDocumentTextDetection ->|  (paginate)|            |            |
  |               |<-- LINE blocks -----------|             |            |            |
  |               |  generateContent(prompt) ------------------------->|            |
  |               |<-- JSON bank statements ---------------------------|            |
  |               | update {data,status:COMPLETED} -------------------------------->|
  |               |               |           |             |            |            |
  |  GET /:jobId  |               |           |             |            |            |
  |--------------->| findOne(jobId) -------------------------------------------------->|
  |<-{status,data} |               |           |             |            |            |
```

---

## 7. Data Model (`schema/bank-statement.schema.ts`)

**`ExtractedDocument`** (top-level, `timestamps: true`) — one per Textract job:
- `jobId: string` (required, unique) — Textract job id, the correlation key.
- `data: BankStatement[]` (default `[]`) — the AI-normalized result.
- `status: 'PROCESSING' | 'COMPLETED' | 'FAILED'` (default `PROCESSING`).

**`BankStatement`** (embedded): `fileName`, `bankName`, `accountHolderName`,
`accountNumber`, `accountType`, `currency` (default `INR`), `statementStartDate`,
`statementEndDate`, `openingBalance`, `closingBalance`, `transactions[]`.

**`Transaction`** (embedded): `date`, `description`, `debitAmount`,
`creditAmount`, `runningBalance`.

---

## 8. AWS & AI Clients

**`aws/aws.service.ts`** — builds and exposes both AWS clients from config
(`ACCESS_KEY`, `SECRET_KEY`, `REGION`):
- `getS3Client(): S3Client`
- `getTextractClient(): TextractClient`

**`ai/ai.service.ts`** — builds a `GoogleGenAI` client from `GEMINI_API_KEY`,
exposed via `getClient()`.

Both are provided by their own modules (`AWSModule`, `AIModule`) and imported
into `BankStatementModule`.

---

## 9. Environment Variables

| Variable         | Used for                                             |
| ---------------- | ---------------------------------------------------- |
| `MONGODB_URI`    | MongoDB connection string                            |
| `S3_BUCKET_NAME` | Target S3 bucket for uploads                         |
| `ACCESS_KEY`     | AWS access key id (S3 + Textract)                    |
| `SECRET_KEY`     | AWS secret access key                                |
| `REGION`         | AWS region                                           |
| `ROLE_ARN`       | IAM role Textract assumes to publish to SNS          |
| `SNS_TOPIC_ARN`  | SNS topic Textract notifies on job completion        |
| `GEMINI_API_KEY` | Google Gemini API key                                |

---

## 10. Key Takeaways

- **PDF text is extracted by AWS Textract (OCR), not a local library.** The app
  never reads PDF content itself — it hands the S3 object to Textract and waits.
- **The flow is asynchronous.** `/upload` returns a `jobId` immediately; the
  result is delivered later through the SNS `/notify` webhook and retrieved by
  polling `GET /:jobId`.
- **Gemini turns raw OCR lines into structured JSON** matching the bank-statement
  schema before it's stored.
- **`status` on `ExtractedDocument`** (`PROCESSING → COMPLETED/FAILED`) is how the
  client tracks progress.

> Note: `/tmp/uploads` is used for temporary storage and cleaned up after S3 upload.
> There are several `console.log` debug statements throughout the service that
> could be removed for production.
