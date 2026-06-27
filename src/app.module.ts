import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { BankStatementModule } from './bank-statement/bank-statement.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), //environment variable key/value pairs are parsed and resolved loaded in process.env adnd now   The forRoot() method registers the ConfigService provider, which provides a get() method for reading these parsed/merged configuration variables.
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    BankStatementModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
