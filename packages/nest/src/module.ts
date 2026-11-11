/**
 * Register once in your root module and every server error gets captured:
 *
 *   import { EverockModule } from '@everock/nest';
 *   @Module({ imports: [EverockModule.forRoot()] })
 *   export class AppModule {}
 *
 * forRoot() also starts the SDK (idempotent with the instrument import).
 */
import { Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { NodeInitOptions } from '@everock/sdk/node';
import { EverockInterceptor } from './interceptor.js';
import { init } from './instrument.js';
import {shutdown} from '@everock/sdk/node';

@Module({})
export class EverockModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> { await shutdown(); }
  static forRoot(opts: Partial<NodeInitOptions> = {}): DynamicModule {
    init(opts);
    return {
      module: EverockModule,
      providers: [{ provide: APP_INTERCEPTOR, useClass: EverockInterceptor }],
    };
  }
}

export { init, captureError, capture, webhook, flush, withSpan } from './instrument.js';
export { EverockInterceptor } from './interceptor.js';
