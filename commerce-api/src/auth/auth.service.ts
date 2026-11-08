import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { User } from '../database/entities.js';
import type { LoginDto, RegisterDto } from './auth.dto.js';

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

  private async session(user: User) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });
    return { accessToken, tokenType: 'Bearer', user: this.publicUser(user) };
  }

  private publicUser(u: User) {
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  }
}
