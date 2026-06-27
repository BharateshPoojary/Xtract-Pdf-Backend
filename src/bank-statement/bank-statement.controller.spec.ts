import { Test, TestingModule } from '@nestjs/testing';
import { BankStatementController } from './bank-statement.controller';
import { BankStatementService } from './bank-statement.service';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { ExtractedDocument } from './schema/bank-statement.schema';
import { AWSClientService } from '../aws/aws.service';
import { AIClientService } from '../ai/ai.service';

//The main intention of this testing is to see whethercontroller is correctly calling the respective service methods or not
describe('BankStatementController', () => {
  let controller: BankStatementController;
  let bankService: BankStatementService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BankStatementController],
      providers: [
        BankStatementService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('mock-value'),
          },
        },
        {
          provide: getModelToken(ExtractedDocument.name),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            findByIdAndUpdate: jest.fn(),
            deleteOne: jest.fn(),
          },
        },
        {
          provide: AWSClientService,
          useValue: {
            getS3Client: jest.fn(),
            getTextractClient: jest.fn(),
          },
        },
        {
          provide: AIClientService,
          useValue: {
            getClient: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<BankStatementController>(BankStatementController);
    bankService = module.get<BankStatementService>(BankStatementService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── getIndexPage ────────────────────────────────────────────────
  describe('getIndexPage', () => {
    it('should return { message: Hello }', () => {
      const result = controller.getIndexPage();
      expect(result).toEqual({ message: 'Hello' });
    });
  });

  // ─── uploadFile ──────────────────────────────────────────────────
  describe('uploadFile', () => {
    it('should call handleUploadAndDocExtraction with file and return result', async () => {
      const mockFile = {
        fieldname: 'file',
        originalname: 'test.pdf',
        mimetype: 'application/pdf',
        size: 1024,
        path: '/tmp/uploads/test.pdf',
      } as Express.Multer.File;

      const mockResponse = {
        message: 'File uploaded successfully',
        jobId: 'job-123',
        s3Key: 's3/test.pdf',
      };

      jest
        .spyOn(bankService, 'handleUploadAndDocExtraction')
        .mockResolvedValue(mockResponse);

      const result = await controller.uploadFile(mockFile);

      expect(bankService.handleUploadAndDocExtraction).toHaveBeenCalledWith(
        mockFile,
      );
      expect(result).toEqual(mockResponse);
    });

    it('should throw if service throws', async () => {
      const mockFile = { originalname: 'test.pdf' } as Express.Multer.File;

      // ✅ spyOn to simulate rejection
      jest
        .spyOn(bankService, 'handleUploadAndDocExtraction')
        .mockRejectedValue(new BadRequestException('Upload failed'));

      await expect(controller.uploadFile(mockFile)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── handleNotification ──────────────────────────────────────────
  describe('handleNotification', () => {
    it('should call handleNotification with body and return result', async () => {
      const mockBody = { jobId: 'job-123', status: 'completed' }; //This will be sent by SNS
      const mockResponse = 'Message Received';

      jest
        .spyOn(bankService, 'handleNotification')
        .mockResolvedValue(mockResponse); //First mocking the service

      const result = await controller.handleNotification(mockBody); //calling the controller with any required payload

      expect(bankService.handleNotification).toHaveBeenCalledWith(mockBody);
      //Once the controller is called We are now ensuring  that the controller correctly passed the valid args to the  service here (handleNotification)
      expect(result).toEqual(mockResponse);
      //Lastly we are expecting that the result of the controller must match  the mock response
    });

    it('should throw BadRequestException when body is empty', async () => {
      const spy = jest.spyOn(bankService, 'handleNotification');

      expect(() => controller.handleNotification({})).toThrow(
        BadRequestException,
      );

      // ✅ Service should never be called with empty body
      expect(spy).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when body is null', async () => {
      const spy = jest.spyOn(bankService, 'handleNotification');

      expect(() => controller.handleNotification(null)).toThrow(
        BadRequestException,
      );
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ─── getDocById ──────────────────────────────────────────────────
  describe('getDocById', () => {
    it('should call getByJobId with jobId and return result', async () => {
      const mockJobId = 'job-123';
      const mockResponse = { jobId: mockJobId, status: 'completed', data: [] };

      // ✅ spyOn instance method
      jest.spyOn(bankService, 'getByJobId').mockResolvedValue(mockResponse);

      const result = await controller.getDocById(mockJobId);

      expect(bankService.getByJobId).toHaveBeenCalledWith(mockJobId);
      expect(result).toEqual(mockResponse);
    });

    it('should throw if jobId does not exist', async () => {
      jest
        .spyOn(bankService, 'getByJobId')
        .mockRejectedValue(new BadRequestException('Job not found'));

      await expect(controller.getDocById('invalid-id')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
