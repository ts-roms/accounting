import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './app-config.service';
import { parseEnv } from './env.schema';

@Global()
@Module({
  providers: [{ provide: AppConfigService, useFactory: () => new AppConfigService(parseEnv()) }],
  exports: [AppConfigService],
})
export class AppConfigModule {}
