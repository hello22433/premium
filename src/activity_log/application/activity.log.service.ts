import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActivityLogEntity } from '../../entity/activity.log.entity';
import { ActivityLogResult } from '../interface/activity.log.result';
import { UserEntity } from '../../entity/user.entity';
import { PasswordBcryptEncrypt } from '../../auth/infrastructure/password.bcrypt.encrypt';

export type CreateActivityLogDto = {
  userId: number;
  userEmail: string;
  method: string;
  requestUrl: string;
  actionType: string;
  ipAddress: string;
  userAgent?: string;
  statusCode: number;
  result: ActivityLogResult;
  responseTime: number;
  downloadReason?: string;
  recordCount?: number;
  requestParams?: any;
  errorMessage?: string;
};

@Injectable()
export class ActivityLogService {
  constructor(
    @InjectRepository(ActivityLogEntity)
    private activityLogRepository: Repository<ActivityLogEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    private passwordBcryptEncrypt: PasswordBcryptEncrypt,
  ) {}

  /**
   * 활동 로그 생성
   */
  async createLog(dto: CreateActivityLogDto): Promise<void> {
    await this.activityLogRepository.insert({
      userId: dto.userId,
      userEmail: dto.userEmail,
      method: dto.method,
      requestUrl: dto.requestUrl,
      actionType: dto.actionType,
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent || null,
      statusCode: dto.statusCode,
      result: dto.result,
      responseTime: dto.responseTime,
      downloadReason: dto.downloadReason || null,
      recordCount: dto.recordCount || null,
      requestParams: dto.requestParams || null,
      errorMessage: dto.errorMessage || null,
    });
  }

  /**
   * 비밀번호 확인
   * @param userId 사용자 ID
   * @param password 입력받은 비밀번호
   * @throws UnauthorizedException 비밀번호가 일치하지 않는 경우
   */
  async verifyPassword(userId: number, password: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('사용자를 찾을 수 없습니다.');
    }

    const isPasswordValid = await this.passwordBcryptEncrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('비밀번호가 일치하지 않습니다.');
    }
  }
}
