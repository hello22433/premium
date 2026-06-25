import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ForbiddenWordEntity } from '../../entity/forbidden.word.entity';

/**
 * 금칙어 매칭 엔진.
 *
 * - 활성(is_active=1) 금칙어 목록을 메모리 캐시.
 * - 완전일치 단어 포함(includes) 검사. 변형우회/정규식/임베딩 미적용.
 * - 정규화: 공백 제거 + 소문자화 정도만.
 * - CRUD 변경 시 refreshCache() 호출로 갱신.
 *
 * OrderModule이 이 provider만 import 하여 사용 (순환의존 회피).
 */
@Injectable()
export class ForbiddenWordMatcher implements OnModuleInit {
  private readonly logger = new Logger(ForbiddenWordMatcher.name);

  // 정규화된 금칙어 목록 (캐시)
  private normalizedWords: string[] = [];

  constructor(
    @InjectRepository(ForbiddenWordEntity)
    private readonly forbiddenWordRepository: Repository<ForbiddenWordEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshCache();
  }

  /**
   * 활성 금칙어 목록을 DB에서 다시 읽어 캐시 갱신.
   */
  async refreshCache(): Promise<void> {
    const activeWords = await this.forbiddenWordRepository.find({
      where: { isActive: 1 },
      select: ['word'],
    });

    this.normalizedWords = activeWords.map((row) => this.normalize(row.word)).filter((word) => word.length > 0);

    this.logger.log(`금칙어 캐시 갱신 완료 (활성 단어 ${this.normalizedWords.length}개)`);
  }

  /**
   * 텍스트에서 적발된 금칙어(원본 정규화 형태) 배열 반환. 없으면 [].
   */
  scan(text: string | null | undefined): string[] {
    const normalizedText = text ? this.normalize(text) : '';
    if (normalizedText.length === 0) {
      return [];
    }

    return this.normalizedWords.filter((word) => normalizedText.includes(word));
  }

  /**
   * 공백 제거 + 소문자화. 변형우회 정규화는 범위 외.
   */
  private normalize(text: string): string {
    return text.replace(/\s+/g, '').toLowerCase();
  }
}
