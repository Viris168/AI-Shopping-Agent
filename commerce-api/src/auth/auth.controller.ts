import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import { LoginDto, RegisterDto } from './auth.dto.js';
import {
  CurrentUser,
  JwtAuthGuard,
  OptionalJwtAuthGuard,
  type AuthUser,
} from './auth.guards.js';
import { AuthService, type SignedToken } from './auth.service.js';
import { SESSION_COOKIE } from './jwt.config.js';

const PER_MINUTE = 60_000;

// httpOnly keeps the session token away from page scripts (an XSS bug can't steal it).
const COOKIE: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/api/v1',
};

function setSession(res: Response, session: SignedToken) {
  res.cookie(SESSION_COOKIE, session.token, {
    ...COOKIE,
    expires: session.expiresAt,
  });
}

// Storefront only: the agent never registers or logs in (docs/AGENT.md §3).
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: PER_MINUTE } })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.register(dto);
    setSession(res, session);
    return { user: session.user, expiresAt: session.expiresAt };
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: PER_MINUTE } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.login(dto);
    setSession(res, session);
    return { user: session.user, expiresAt: session.expiresAt };
  }

  /** Revokes all of the shopper's tokens (every device, and any chat token) and clears the cookie. */
  @Post('logout')
  @HttpCode(204)
  @UseGuards(OptionalJwtAuthGuard)
  async logout(
    @CurrentUser() user: AuthUser | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (user) await this.auth.logout(user.id);
    res.clearCookie(SESSION_COOKIE, COOKIE);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  /** For the chat widget: a short-lived token to pass to agent-service (ARCHITECTURE.md §4.3). */
  @Post('agent-token')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  async agentToken(@CurrentUser() user: AuthUser) {
    const { token, expiresAt } = await this.auth.agentToken(user.id);
    return { token, expiresAt };
  }
}
