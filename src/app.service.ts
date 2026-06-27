import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): Record<string, string> {
    return { message: 'Hello Bharat FROM GITHIUB ACTION PUSH' };
  }
}
