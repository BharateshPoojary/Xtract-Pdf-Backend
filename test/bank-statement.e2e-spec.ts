import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import * as path from 'path';
import { getModelToken } from '@nestjs/mongoose';

import { Model } from 'mongoose';
import { AppModule } from '../src/app.module';
import { ExtractedDocument } from '../src/bank-statement/schema/bank-statement.schema';

describe('BankStatementController (e2e)', () => {
  let app: INestApplication<App>;
  let extractedDocModel: Model<ExtractedDocument>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    extractedDocModel = moduleFixture.get<Model<ExtractedDocument>>(
      getModelToken(ExtractedDocument.name), //This line is retrieving the model token which nest mongoose internally creates during model creation using this token we can perform the db opertaions on that
    );
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    await extractedDocModel.deleteMany({});
  });

  describe('GET /test', () => {
    it('should return Hello message', () => {
      return request(app.getHttpServer())
        .get('/test')
        .expect(200)
        .expect({ message: 'Hello' });
    });
  });

  describe('POST /upload', () => {
    it('should upload a valid PDF file and return jobId and s3Key', () => {
      return (
        request(app.getHttpServer())
          .post('/upload')
          .attach('file', path.resolve(__dirname, './fixtures/bank-stmt.pdf')) //__dirname returns the absolute path till our current directory i.e test and second parameter is the string we are appending to that that is file path only
          //path.resolve then joins __dirname with ./fixtures/bank-stmt.pdf to give the full absolute path to the file. If the file doesn't exist at that path, you'll get the Aborted error you saw earlier.
          .expect(201)
          .expect((res) => {
            expect(res.body).toHaveProperty('message');
            expect(res.body).toHaveProperty('jobId');
            expect(res.body).toHaveProperty('s3Key');
          })
      );
    });

    it('should return 400 if no file is attached', () => {
      return request(app.getHttpServer())
        .post('/upload')
        .expect(400)
        .expect((res) => {
          expect(res.body?.message).toBe('No file uploaded');
        });
    });
  });

  // ─── POST /notify ─────────────────────────────────────────────────
  describe('POST /notify', () => {
    it('should handle a valid notification body', () => {
      const mockBody = { jobId: 'job-123', status: 'completed' };

      return request(app.getHttpServer())
        .post('/notify')
        .send(mockBody)
        .expect(201)
        .expect((res) => {
          expect(res.body).toBeDefined();
        });
    });

    it('should return 400 if body is empty', () => {
      return request(app.getHttpServer())
        .post('/notify')
        .send({})
        .expect(400)
        .expect((res) => {
          expect(res.body?.message).toBe('Request body is empty');
        });
    });
  });

  // ─── GET /:jobId ──────────────────────────────────────────────────
  describe('GET /:jobId', () => {
    let seededJobId: string;

    beforeEach(async () => {
      const doc = await extractedDocModel.create({
        jobId: 'job-123',
        status: 'PROCESSING',
        data: [],
      });

      seededJobId = doc.jobId;
    });

    afterEach(async () => {
      await extractedDocModel.deleteMany({});
    });

    it('should return document for a valid jobId', () => {
      return request(app.getHttpServer())
        .get(`/${seededJobId}`)
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('jobId', seededJobId);
          expect(res.body).toHaveProperty('status');
          expect(res.body).toHaveProperty('data');
        });
    });

    it('should return 404 for a non-existent jobId', () => {
      return request(app.getHttpServer())
        .get('/non-existent-job-id')
        .expect(404) // ✅ NotFoundException = 404
        .expect((res) => {
          expect(res.body?.message).toBe('Job not found');
        });
    });
  });
});
