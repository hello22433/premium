import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EmailManualEntity } from '../../entity/email.manual.entity';
import { EmailManualUpsertReqDto } from '../api/email.manual.req.dto';
import { EmailManualGetResDto } from '../api/email.manual.res.dto';
import { ILoginUserInfo } from '../../auth/interface/login.user';
import { UserEntity } from '../../entity/user.entity';

@Injectable()
export class EmailManualService {
  constructor(
    @InjectRepository(EmailManualEntity)
    private emailManualRepository: Repository<EmailManualEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  async get(): Promise<EmailManualGetResDto> {
    const emailManual = await this.emailManualRepository.findOne({
      where: {},
      order: { id: 'DESC' },
      relations: ['user'],
    });

    if (!emailManual) {
      return {
        id: null,
        content: null,
        userId: null,
        userEmail: null,
        updatedAt: null,
      };
    }

    return {
      id: emailManual.id,
      content: emailManual.content,
      userId: emailManual.userId,
      userEmail: emailManual.user?.email || null,
      updatedAt: emailManual.updatedAt,
    };
  }

  async upsert(user: ILoginUserInfo, dto: EmailManualUpsertReqDto): Promise<void> {
    const existingManual = await this.emailManualRepository.findOne({
      where: {},
      order: { id: 'DESC' },
    });

    if (existingManual) {
      // 기존 레코드는 soft delete
      await this.emailManualRepository.softRemove(existingManual);
    }

    // 새로운 레코드 insert
    const newManual = this.emailManualRepository.create({
      content: dto.content,
      userId: user.id,
    });
    await this.emailManualRepository.save(newManual);
  }
}
