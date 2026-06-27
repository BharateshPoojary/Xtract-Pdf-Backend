import { Module } from '@nestjs/common';
import { AWSClientService } from './aws.service';

@Module({
  providers: [AWSClientService],
  exports: [AWSClientService],
})
export class AWSModule {}
