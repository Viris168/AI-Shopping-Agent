import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import {
  JwtAuthGuard,
  OptionalJwtAuthGuard,
  RolesGuard,
} from './auth.guards.js';
import { AuthService } from './auth.service.js';
import { JWT_ISSUER, jwtExpiresIn, jwtSecret } from './jwt.config.js';

// Global so every feature module can use the guards without importing AuthModule.
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: jwtSecret(),
        signOptions: {
          issuer: JWT_ISSUER,
          expiresIn: jwtExpiresIn() as `${number}h`,
          algorithm: 'HS256',
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, OptionalJwtAuthGuard, RolesGuard],
  exports: [JwtModule, JwtAuthGuard, OptionalJwtAuthGuard, RolesGuard],
})
export class AuthModule {}
