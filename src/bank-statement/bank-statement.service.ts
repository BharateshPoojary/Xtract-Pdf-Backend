import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as fs from 'fs';
import {
  StartDocumentTextDetectionCommand,
  GetDocumentTextDetectionCommand,
  type StartDocumentTextDetectionCommandInput,
  type GetDocumentTextDetectionCommandOutput,
} from '@aws-sdk/client-textract';
import {
  PutObjectCommand,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';

import {
  BankStatement,
  ExtractedDocument,
} from './schema/bank-statement.schema';
import { ConfigService } from '@nestjs/config';
import { AWSClientService } from '../aws/aws.service';
import { AIClientService } from '../ai/ai.service';
import { BankStatementExtractor } from '../aws/prompt/extractor-prompt';

@Injectable()
export class BankStatementService {
  constructor(
    @InjectModel(ExtractedDocument.name)
    private ExtractedDocumentModal: Model<ExtractedDocument>,
    private readonly configService: ConfigService,
    private readonly awsClientService: AWSClientService,
    private readonly aiClientService: AIClientService,
  ) {}

  async handleUploadAndDocExtraction(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    try {
      const filePath = file.path;
      const fileBuffer = fs.readFileSync(filePath);

      const bucketName = this.configService.get<string>('S3_BUCKET_NAME');
      const s3Key = `uploads/${Date.now()}~${file.originalname}`;
      console.log('File Buffer', fileBuffer);
      const s3Params: PutObjectCommandInput = {
        Bucket: bucketName,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: file.mimetype,
      };

      const s3Command = new PutObjectCommand(s3Params);
      await this.awsClientService.getS3Client().send(s3Command);
      console.log(`File uploaded to S3: ${s3Key}`);

      const textractParams: StartDocumentTextDetectionCommandInput = {
        DocumentLocation: {
          S3Object: {
            Bucket: bucketName,
            Name: s3Key,
          },
        },
        NotificationChannel: {
          RoleArn: this.configService.get<string>('ROLE_ARN'),
          SNSTopicArn: this.configService.get<string>('SNS_TOPIC_ARN'),
        },
      };

      const textractCommand = new StartDocumentTextDetectionCommand(
        textractParams,
      );
      const data = await this.awsClientService
        .getTextractClient()
        .send(textractCommand);
      console.log('Textract job started:', data.JobId);

      if (data.JobId) {
        console.log('Iam here at one');
        await this.ExtractedDocumentModal.create({
          jobId: data.JobId,
          data: [],
          status: 'PROCESSING',
        });
      } else {
        throw new Error('Failed to get job Id');
      }

      // Delete local file after uploading to S3
      fs.unlinkSync(filePath);

      return {
        message: 'File uploaded and processing started',
        jobId: data.JobId,
        s3Key: s3Key,
      };
    } catch (error) {
      console.error(error);
      throw new InternalServerErrorException(
        error instanceof Error ? error.message : 'Error Occurred',
      );
    }
  }

  async handleNotification(body: any): Promise<string> {
    try {
      console.log('Body ', body);
      // Parse the body if it's a string
      if (typeof body === 'string') {
        body = JSON.parse(body);
      }
      console.log('I  am notified');
      // Handle subscription confirmation
      if (body.Type === 'SubscriptionConfirmation') {
        const subscribeURL = body.SubscribeURL;

        // Visit the URL to confirm
        const response = await fetch(subscribeURL);
        await response.text();

        return 'Subscription confirmed';
      }

      // Handle notifications
      if (body.Type === 'Notification') {
        const message = JSON.parse(body.Message);
        console.log('Textract notification:', message);

        if (message.Status === 'SUCCEEDED') {
          const fileName =
            message.DocumentLocation.S3ObjectName.split('~').pop();

          const data = await this.getDocText(message.JobId, fileName);
          await this.ExtractedDocumentModal.findOneAndUpdate(
            { jobId: message.JobId },
            {
              data,
              status: 'COMPLETED',
            },
            { new: true },
          );

          return 'Message received';
        } else if (message.Status === 'FAILED') {
          await this.ExtractedDocumentModal.findOneAndUpdate(
            { jobId: message.JobId },
            { status: 'FAILED' },
          );
          throw new InternalServerErrorException(
            'Error Extracting text from pdf',
          );
        }
      }

      return 'OK';
    } catch (error) {
      console.error('Webhook error:', error);
      throw new InternalServerErrorException('Error processing notification');
    }
  }

  private async getDocText(jobId: string, fileName: string) {
    const allBlocks: any[] = [];
    let nextToken: string | undefined = undefined;
    let pageCount = 0;

    // Keep fetching until there's no NextToken
    do {
      pageCount++;
      console.log(`Fetching page ${pageCount}...`);

      const command = new GetDocumentTextDetectionCommand({
        JobId: jobId,
        MaxResults: 1000,
        NextToken: nextToken,
      });

      const response: GetDocumentTextDetectionCommandOutput =
        await this.awsClientService.getTextractClient().send(command);

      if (response.JobStatus === 'FAILED') {
        await this.ExtractedDocumentModal.findOneAndUpdate(
          { jobId },
          { status: 'FAILED' },
        );
        throw new Error('Error detecting text');
      }

      // Collect blocks from this page
      if (response.Blocks) {
        allBlocks.push(...response.Blocks);
      }

      // Get the next token for pagination
      nextToken = response.NextToken;

      console.log(
        `Page ${pageCount}: Got ${
          response.Blocks?.length || 0
        } blocks. NextToken: ${nextToken ? 'exists' : 'none'}`,
      );
    } while (nextToken);

    console.log(
      `Total blocks retrieved: ${allBlocks.length} across ${pageCount} pages`,
    );

    // Extract text from all blocks
    const text = allBlocks
      .filter((block) => block.BlockType === 'LINE')
      .map((block) => block.Text)
      .join('\n');

    console.log(`Total text length: ${text.length} characters`);

    const resultantData = await this.normalizeWithAI(
      text ?? '',
      fileName,
      jobId,
    );

    return resultantData;
  }

  private async normalizeWithAI(
    rawText: string,
    fileName: string,
    jobId: string,
  ): Promise<BankStatement[]> {
    const prompt = BankStatementExtractor.getExtractionTemplate(
      rawText,
      fileName,
    );

    try {
      console.log('Raw Text', rawText);

      const result = await this.aiClientService
        .getClient()
        .models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });
      const response = result.text;
      // console.log("Response", response);
      // Remove markdown code blocks if present
      const cleanedResponse = response
        ?.replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const parsed = JSON.parse(cleanedResponse ?? '');

      // Validate structure
      if (!Array.isArray(parsed) || parsed.length === 0) {
        await this.ExtractedDocumentModal.findOneAndUpdate(
          { jobId },
          { status: 'FAILED' },
        );
        throw new Error('AI response is not an array');
      }
      console.log('parsed', parsed);
      return parsed as BankStatement[];
    } catch (error) {
      console.error('AI normalization error:', error);
      throw new Error('Failed to normalize bank statement with AI');
    }
  }

  async getByJobId(jobId: string) {
    console.log('jobId', jobId);
    if (!jobId) {
      throw new BadRequestException('Please send a jobId');
    }

    const document = await this.ExtractedDocumentModal.findOne({ jobId });

    if (!document) {
      throw new NotFoundException('Job not found');
    }

    return {
      jobId: document.jobId,
      status: document.status,
      data: document.data,
    };
  }
}
