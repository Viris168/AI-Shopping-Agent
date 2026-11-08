import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { jwtSecret } from './auth/jwt.config.js';
import { serviceToken } from './common/service-token.middleware.js';
import { configureApp } from './setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  jwtSecret(); // fails fast in production without a real secret
  if (!process.env.JWT_SECRET)
    logger.warn('JWT_SECRET is not set; using the dev-only secret');
  if (!serviceToken())
    // also fails fast in production
    logger.warn('SERVICE_TOKEN is not set; agent requests will be rejected');
  // Behind a load balancer, set to the hop count so req.ip (throttling) is the client's.
  if (process.env.TRUST_PROXY)
    app.set('trust proxy', Number(process.env.TRUST_PROXY));

  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:8080')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
  });
  configureApp(app);

  const swagger = new DocumentBuilder()
    .setTitle('commerce-api')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () =>
    SwaggerModule.createDocument(app, swagger),
  );

  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}
await bootstrap();
