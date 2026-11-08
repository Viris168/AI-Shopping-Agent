import { type INestApplication, ValidationPipe } from '@nestjs/common';

/** Prefix and validation, shared by main.ts and the e2e tests. */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
