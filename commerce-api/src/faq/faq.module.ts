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
import { In, Repository } from 'typeorm';
import { FAQ_TOPICS, FaqArticle, type FaqTopic } from '../database/entities.js';
import { toVectorLiteral } from '../search/embedding.js';
import { rrf } from '../search/rrf.js';
import { EmbeddingService, SearchModule } from '../search/search.module.js';

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
const TSVECTOR = `(setweight(to_tsvector('english', f.question), 'A') || setweight(to_tsvector('english', f.answer), 'C'))`;
const CANDIDATES = 10;
const RESULTS = 3;
/**
 * Vector matches below this cosine similarity are dropped, so a question the FAQ doesn't cover
 * ("Do you price-match?", 0.60) still returns nothing while casual rewordings ("can I send stuff
 * back", 0.70) are found. Calibrated on the seed FAQs; checked by test/search.e2e-spec.ts.
 */
export const FAQ_MIN_SIMILARITY = 0.64;

@Injectable()
export class FaqService {
  constructor(
    @InjectRepository(FaqArticle) private readonly faqs: Repository<FaqArticle>,
    private readonly embeddings: EmbeddingService,
  ) {}

  /**
   * Hybrid search: full-text and vector matches, fused by rank (RRF). Without the model
   * (SEARCH_HYBRID=false, still loading, too slow) it is the full-text search alone.
   * Empty `results` means no grounded answer (docs/AGENT.md §4).
   */
  async search(dto: SearchFaqDto) {
    const [vector, keyword] = await Promise.all([
      this.vectorIds(dto),
      this.keywordIds(dto),
    ]);
    // Vector first: a tie (each list's #1 differs) goes to the semantic match, which already
    // passed FAQ_MIN_SIMILARITY, not to a one-word keyword hit ("send" in an unrelated answer).
    const top = rrf([vector, keyword]).slice(0, RESULTS);
    if (top.length === 0) return { results: [] };

    const rows = await this.faqs.findBy({ id: In(top.map((t) => t.id)) });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      results: top.flatMap(({ id, score }) => {
        const r = byId.get(id);
        return r
          ? [
              {
                topic: r.topic,
                question: r.question,
                answer: r.answer,
                score: score.toFixed(3),
              },
            ]
          : [];
      }),
    };
  }

  private async keywordIds(dto: SearchFaqDto): Promise<string[]> {
    // Words of 3+ letters/digits, OR-ed. Only [a-z0-9] reach to_tsquery, so no syntax errors.
    const words = [
      ...new Set(
        dto.q
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 3),
      ),
    ].slice(0, 12);
    if (words.length === 0) return [];

    const qb = this.faqs
      .createQueryBuilder('f')
      .select('f.id', 'id')
      .where(`${TSVECTOR} @@ to_tsquery('english', :query)`, {
        query: words.join(' | '),
      })
      .orderBy(`ts_rank(${TSVECTOR}, to_tsquery('english', :query))`, 'DESC')
      .limit(CANDIDATES);
    if (dto.topic) qb.andWhere('f.topic = :topic', { topic: dto.topic });
    return (await qb.getRawMany<{ id: string }>()).map((r) => r.id);
  }

  private async vectorIds(dto: SearchFaqDto): Promise<string[]> {
    const embedding = await this.embeddings.embedQuery(dto.q);
    if (!embedding) return [];

    const qb = this.faqs
      .createQueryBuilder('f')
      .select('f.id', 'id')
      .where('f.embedding IS NOT NULL')
      .andWhere('1 - (f.embedding <=> CAST(:embedding AS vector)) >= :min', {
        embedding: toVectorLiteral(embedding),
        min: FAQ_MIN_SIMILARITY,
      })
      .orderBy('f.embedding <=> CAST(:embedding AS vector)', 'ASC')
      .limit(CANDIDATES);
    if (dto.topic) qb.andWhere('f.topic = :topic', { topic: dto.topic });
    return (await qb.getRawMany<{ id: string }>()).map((r) => r.id);
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

@Module({
  imports: [SearchModule],
  controllers: [FaqController],
  providers: [FaqService],
})
export class FaqModule {}
