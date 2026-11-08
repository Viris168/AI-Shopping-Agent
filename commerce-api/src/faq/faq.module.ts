import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Repository } from 'typeorm';
import { FAQ_TOPICS, FaqArticle, type FaqTopic } from '../database/entities.js';

export class SearchFaqDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  q: string;

  @IsOptional()
  @IsIn(FAQ_TOPICS)
  topic?: FaqTopic;
}

// Same expression as the IDX_faq_articles_fts index (SearchIndexes migration).
const VECTOR = `(setweight(to_tsvector('english', f.question), 'A') || setweight(to_tsvector('english', f.answer), 'C'))`;

@Injectable()
export class FaqService {
  constructor(
    @InjectRepository(FaqArticle) private readonly faqs: Repository<FaqArticle>,
  ) {}

  /** Empty `results` means no grounded answer (docs/AGENT.md §4). */
  async search(dto: SearchFaqDto) {
    // Words of 3+ letters/digits, OR-ed. Only [a-z0-9] reach to_tsquery, so no syntax errors.
    const words = [
      ...new Set(
        dto.q
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 3),
      ),
    ].slice(0, 12);
    if (words.length === 0) return { results: [] };

    const qb = this.faqs
      .createQueryBuilder('f')
      .select([
        'f.topic AS topic',
        'f.question AS question',
        'f.answer AS answer',
      ])
      .addSelect(`ts_rank(${VECTOR}, to_tsquery('english', :query))`, 'score')
      .where(`${VECTOR} @@ to_tsquery('english', :query)`, {
        query: words.join(' | '),
      })
      .orderBy('score', 'DESC')
      .limit(3);
    if (dto.topic) qb.andWhere('f.topic = :topic', { topic: dto.topic });

    const rows = await qb.getRawMany<{
      topic: FaqTopic;
      question: string;
      answer: string;
      score: number;
    }>();
    return {
      results: rows.map((r) => ({ ...r, score: Number(r.score).toFixed(3) })),
    };
  }
}

@ApiTags('faq')
@Controller('faq')
export class FaqController {
  constructor(private readonly faq: FaqService) {}

  @Get('search')
  search(@Query() query: SearchFaqDto) {
    return this.faq.search(query);
  }
}

@Module({ controllers: [FaqController], providers: [FaqService] })
export class FaqModule {}
