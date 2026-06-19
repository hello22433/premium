import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ForbiddenWordEntity } from '../../entity/forbidden.word.entity';
import { ForbiddenWordHistoryEntity } from '../../entity/forbidden.word.history.entity';
import { ForbiddenWordBlockLogEntity } from '../../entity/forbidden.word.block.log.entity';
import { ForbiddenWordAction } from '../interface/forbidden.word.action';
import { ForbiddenWordMatcher } from './forbidden.word.matcher';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import {
  ForbiddenWordCreateReqDto,
  ForbiddenWordGetBlockLogReqQueryDto,
  ForbiddenWordGetHistoryReqQueryDto,
  ForbiddenWordGetListReqQueryDto,
  ForbiddenWordUpdateReqDto,
} from '../api/forbidden.word.req.dto';

@Injectable()
export class ForbiddenWordService {
  private readonly logger = new Logger(ForbiddenWordService.name);

  constructor(
    @InjectRepository(ForbiddenWordEntity)
    private readonly forbiddenWordRepository: Repository<ForbiddenWordEntity>,
    @InjectRepository(ForbiddenWordHistoryEntity)
    private readonly forbiddenWordHistoryRepository: Repository<ForbiddenWordHistoryEntity>,
    @InjectRepository(ForbiddenWordBlockLogEntity)
    private readonly forbiddenWordBlockLogRepository: Repository<ForbiddenWordBlockLogEntity>,
    private readonly forbiddenWordMatcher: ForbiddenWordMatcher,
  ) {}

  async getList(getQuery: ForbiddenWordGetListReqQueryDto) {
    const { take, page, keyword, category, isActive } = getQuery;

    let queryBuilder = this.forbiddenWordRepository.createQueryBuilder('forbiddenWord');

    if (keyword) {
      queryBuilder = queryBuilder.andWhere('forbiddenWord.word LIKE :keyword', {
        keyword: `%${keyword}%`,
      });
    }
    if (category) {
      queryBuilder = queryBuilder.andWhere('forbiddenWord.category = :category', { category });
    }
    if (isActive !== undefined) {
      queryBuilder = queryBuilder.andWhere('forbiddenWord.isActive = :isActive', {
        isActive: isActive ? 1 : 0,
      });
    }

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take).orderBy('forbiddenWord.id', 'DESC');

    const [list, totalCount] = await queryBuilder.getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    return { list, totalCount, totalPage, currentPage: page };
  }

  async create(user: ILoginUserInfo, getBody: ForbiddenWordCreateReqDto): Promise<void> {
    const word = getBody.word.trim();
    if (!word) {
      throw new BadRequestException('금칙어를 입력해주세요.');
    }

    const exists = await this.forbiddenWordRepository.findOne({ where: { word } });
    if (exists) {
      throw new BadRequestException('이미 등록된 금칙어입니다.');
    }

    await this.forbiddenWordRepository.insert({
      word,
      category: getBody.category ?? null,
      isActive: 1,
    });

    await this.recordHistory(ForbiddenWordAction.ADD, word, getBody.reason, user);
    await this.forbiddenWordMatcher.refreshCache();
  }

  async update(user: ILoginUserInfo, id: number, getBody: ForbiddenWordUpdateReqDto): Promise<void> {
    const forbiddenWord = await this.forbiddenWordRepository.findOne({ where: { id } });
    if (!forbiddenWord) {
      throw new BadRequestException('존재하지 않는 금칙어입니다.');
    }

    if (getBody.word !== undefined) {
      const newWord = getBody.word.trim();
      if (!newWord) {
        throw new BadRequestException('금칙어를 입력해주세요.');
      }
      if (newWord !== forbiddenWord.word) {
        const duplicated = await this.forbiddenWordRepository.findOne({ where: { word: newWord } });
        if (duplicated) {
          throw new BadRequestException('이미 등록된 금칙어입니다.');
        }
      }
      forbiddenWord.word = newWord;
    }
    if (getBody.category !== undefined) {
      forbiddenWord.category = getBody.category;
    }
    if (getBody.isActive !== undefined) {
      forbiddenWord.isActive = getBody.isActive ? 1 : 0;
    }

    await this.forbiddenWordRepository.save(forbiddenWord);

    await this.recordHistory(ForbiddenWordAction.UPDATE, forbiddenWord.word, getBody.reason, user);
    await this.forbiddenWordMatcher.refreshCache();
  }

  async delete(user: ILoginUserInfo, id: number, reason: string): Promise<void> {
    const forbiddenWord = await this.forbiddenWordRepository.findOne({ where: { id } });
    if (!forbiddenWord) {
      throw new BadRequestException('존재하지 않는 금칙어입니다.');
    }

    const word = forbiddenWord.word;
    await this.forbiddenWordRepository.softDelete(id);

    await this.recordHistory(ForbiddenWordAction.DELETE, word, reason, user);
    await this.forbiddenWordMatcher.refreshCache();
  }

  async getHistory(getQuery: ForbiddenWordGetHistoryReqQueryDto) {
    const { take, page, word, changedByEmail, startDate, endDate } = getQuery;

    let queryBuilder = this.forbiddenWordHistoryRepository.createQueryBuilder('history');

    if (word) {
      queryBuilder = queryBuilder.andWhere('history.word LIKE :word', { word: `%${word}%` });
    }
    if (changedByEmail) {
      queryBuilder = queryBuilder.andWhere('history.changedByEmail LIKE :changedByEmail', {
        changedByEmail: `%${changedByEmail}%`,
      });
    }
    if (startDate) {
      queryBuilder = queryBuilder.andWhere('history.createdAt >= :startDate', {
        startDate: `${startDate} 00:00:00`,
      });
    }
    if (endDate) {
      queryBuilder = queryBuilder.andWhere('history.createdAt <= :endDate', {
        endDate: `${endDate} 23:59:59`,
      });
    }

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take).orderBy('history.id', 'DESC');

    const [list, totalCount] = await queryBuilder.getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    return { list, totalCount, totalPage, currentPage: page };
  }

  async getBlockLog(getQuery: ForbiddenWordGetBlockLogReqQueryDto) {
    const { take, page, userEmail, startDate, endDate } = getQuery;

    let queryBuilder = this.forbiddenWordBlockLogRepository.createQueryBuilder('blockLog');

    if (userEmail) {
      queryBuilder = queryBuilder.andWhere('blockLog.userEmail LIKE :userEmail', {
        userEmail: `%${userEmail}%`,
      });
    }
    if (startDate) {
      queryBuilder = queryBuilder.andWhere('blockLog.createdAt >= :startDate', {
        startDate: `${startDate} 00:00:00`,
      });
    }
    if (endDate) {
      queryBuilder = queryBuilder.andWhere('blockLog.createdAt <= :endDate', {
        endDate: `${endDate} 23:59:59`,
      });
    }

    const skip = (page - 1) * take;
    queryBuilder = queryBuilder.skip(skip).take(take).orderBy('blockLog.id', 'DESC');

    const [list, totalCount] = await queryBuilder.getManyAndCount();
    const totalPage = Math.ceil(totalCount / take);

    return { list, totalCount, totalPage, currentPage: page };
  }

  private async recordHistory(
    action: ForbiddenWordAction,
    word: string,
    reason: string,
    user: ILoginUserInfo,
  ): Promise<void> {
    await this.forbiddenWordHistoryRepository.insert({
      word,
      action,
      reason,
      changedByUserId: user.id,
      changedByEmail: user.email,
    });
  }
}
