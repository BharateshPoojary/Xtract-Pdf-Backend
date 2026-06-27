import { Module } from '@nestjs/common';
import { AIClientService } from './ai.service';

@Module({
  providers: [AIClientService],
  exports: [AIClientService],
})
export class AIModule {}
