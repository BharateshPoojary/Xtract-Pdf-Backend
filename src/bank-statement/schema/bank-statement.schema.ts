import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ExtractedDocumentType = HydratedDocument<ExtractedDocument>;

@Schema()
class Transaction {
  @Prop({
    required: true,
  })
  date: string;

  @Prop({
    required: true,
  })
  description: string;

  @Prop({
    required: true,
  })
  debitAmount: number;

  @Prop({
    required: true,
  })
  creditAmount: number;

  @Prop({
    required: true,
  })
  runningBalance: number;
}

const TransactionSchema = SchemaFactory.createForClass(Transaction);

@Schema()
export class BankStatement {
  @Prop({
    required: true,
  })
  fileName: string;

  @Prop({
    required: true,
  })
  bankName: string;

  @Prop({
    required: true,
  })
  accountHolderName: string;

  @Prop({
    required: true,
  })
  accountNumber: string;

  @Prop({
    required: true,
  })
  accountType: string;

  @Prop({
    required: true,
    default: 'INR',
  })
  currency: string;

  @Prop({
    required: true,
  })
  statementStartDate: string;

  @Prop({
    required: true,
  })
  statementEndDate: string;

  @Prop({
    required: true,
  })
  openingBalance: number;

  @Prop({
    required: true,
  })
  closingBalance: number;

  @Prop({
    required: true,
    type: [TransactionSchema],
  })
  transactions: Transaction[];
}

export const BankStatementSchema = SchemaFactory.createForClass(BankStatement);

@Schema({ timestamps: true })
export class ExtractedDocument {
  @Prop({
    required: true,
    unique: true,
  })
  jobId: string;

  @Prop({
    required: true,
    default: [],
    type: [BankStatementSchema],
  })
  data: BankStatement[];
  @Prop({
    enum: ['PROCESSING', 'COMPLETED', 'FAILED'],
    default: 'PROCESSING',
  })
  status: string;
}

export const ExtractedDocumentSchema =
  SchemaFactory.createForClass(ExtractedDocument);
