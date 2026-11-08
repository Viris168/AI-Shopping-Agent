import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { User } from '../database/entities.js';
import type { LoginDto, RegisterDto } from './auth.dto.js';
import type { JwtPayload } from './auth.guards.js';
import {
  AGENT_AUDIENCE,
  agentTokenExpiresIn,
  SESSION_AUDIENCE,
} from './jwt.config.js';

export interface SignedToken {
  token: string;
  expiresAt: Date;
}

export const BCRYPT_COST = 12;

// Compared against when the email is unknown, so both cases take the same time.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    const result = await this.users
      .createQueryBuilder()
      .insert()
      .values({ email: dto.email, name: dto.name, passwordHash })
      .orIgnore()
      .returning('*')
      .execute();
    const row = result.raw[0] as { id: string } | undefined;
    if (!row) throw new ConflictException('Email already registered');
    return this.session(await this.users.findOneByOrFail({ id: row.id }));
  }

  async login(dto: LoginDto) {
    const user = await this.users.findOneBy({ email: dto.email });
    const ok = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_HASH,
    );
    if (!user || !ok)
      throw new UnauthorizedException('Wrong email or password');
    return this.session(user);
  }

  async me(userId: string) {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException('Invalid or expired token');
    return this.publicUser(user);
  }

  /**
   * A short-lived token the chat widget hands to agent-service. It only works together with
   * agent-service's X-Service-Token, and only on @AgentAllowed() routes.
   */
  async agentToken(userId: string): Promise<SignedToken> {
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new UnauthorizedException('Invalid or expired token');
    if (user.role !== 'CUSTOMER')
      throw new ForbiddenException(
        'The assistant is for shopper accounts only',
      );
    return this.sign(user, AGENT_AUDIENCE, agentTokenExpiresIn());
  }

  /** Revokes every token the user holds, on every device (the guard checks `ver`). */
  async logout(userId: string) {
    await this.users.increment({ id: userId }, 'tokenVersion', 1);
  }

  private async session(user: User) {
    const session = await this.sign(user, SESSION_AUDIENCE);
    return { ...session, user: this.publicUser(user) };
  }

  private async sign(
    user: User,
    audience: string,
    expiresIn?: string,
  ): Promise<SignedToken> {
    // No email: tokens reach the browser. Name and role are display/defence-in-depth only;
    // the guard reads both from the database.
    const payload: JwtPayload = {
      sub: user.id,
      ver: user.tokenVersion,
      name: user.name,
      role: user.role,
    };
    const token = await this.jwt.signAsync(payload, {
      audience,
      ...(expiresIn ? { expiresIn: expiresIn as `${number}m` } : {}),
    });
    const { exp } = this.jwt.decode<{ exp: number }>(token);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  private publicUser(u: User) {
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  }
}
