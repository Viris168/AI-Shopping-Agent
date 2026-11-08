import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { CartModule } from './cart/cart.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { AgentAuditInterceptor } from './common/agent-audit.interceptor.js';
import { ServiceTokenMiddleware } from './common/service-token.middleware.js';
import { UserThrottlerGuard } from './common/user-throttler.guard.js';
import { DatabaseModule } from './database/database.module.js';
import { FaqModule } from './faq/faq.module.js';
import { HealthModule } from './health/health.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { ProductsModule } from './products/products.module.js';
import { ReturnsModule } from './returns/returns.module.js';
import { SupportModule } from './support/support.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: {
          level: process.env.LOG_LEVEL ?? 'info',
          redact: [
            'req.headers.authorization',
            'req.headers["x-service-token"]',
            'req.headers.cookie',
          ],
          transport:
            process.env.NODE_ENV === 'production'
              ? undefined
              : { target: 'pino-pretty', options: { singleLine: true } },
        },
      }),
    }),
    // Keyed per shopper by UserThrottlerGuard (ARCHITECTURE.md §11.1).
    ThrottlerModule.forRootAsync({
      useFactory: () => [
        {
          ttl: 60_000,
          limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 120),
        },
      ],
    }),
    DatabaseModule,
    AuthModule,
    HealthModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    ReturnsModule,
    FaqModule,
    SupportModule,
    ConversationsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: AgentAuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  // Before guards, so the throttler and audit see req.isTrustedAgent.
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(ServiceTokenMiddleware).forRoutes('*path');
  }
}
