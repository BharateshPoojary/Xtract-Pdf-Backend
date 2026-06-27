import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BankStatementService } from './bank-statement.service';
import { BankStatementController } from './bank-statement.controller';
import {
  ExtractedDocument,
  ExtractedDocumentSchema,
} from './schema/bank-statement.schema';
import { AIModule } from 'src/ai/ai.module';
import { AWSModule } from 'src/aws/aws.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExtractedDocument.name, schema: ExtractedDocumentSchema },
    ]),
    AIModule,
    AWSModule,
  ],
  providers: [BankStatementService],
  controllers: [BankStatementController],
})
export class BankStatementModule {}
