import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { UserEntity } from '../../entity/user.entity';
import { UserCompanyEntity } from '../../entity/user.company.entity';

/**
 * 잔액·한도·settlement_code 를 바꾸는 모든 경로의 공통 잠금 범위.
 *
 * COMPANY 모드는 회사 row 를 mutex 로 먼저 확보하고, 이어 모든 회사 사용자를
 * ID 오름차순으로 잠근다. 이 순서는 order.deliveryRequest / deliveryConfirmed 및
 * settlement_code 변경(PR-C) 이 동일하게 사용해야 서로 다른 사용자의 동시 발송에서도
 * 순환 대기가 생기지 않는다 (Rev5 B2 / S7).
 *
 * OrderService.lockBillingScope 에서 추출 — 동작은 동일하다.
 *
 * @param manager 명시적 트랜잭션에서 호출 시 EntityManager 전달 (미전달 시 ambient CLS TX 사용).
 */
@Injectable()
export class BillingScopeLockService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(UserCompanyEntity)
    private readonly userCompanyRepository: Repository<UserCompanyEntity>,
  ) {}

  async lock(
    billingUserId: number,
    manager?: EntityManager,
  ): Promise<{ user: UserEntity; companyUsers: UserEntity[] }> {
    const userRepo = manager ? manager.getRepository(UserEntity) : this.userRepository;
    const companyRepo = manager ? manager.getRepository(UserCompanyEntity) : this.userCompanyRepository;

    const billingReference = await userRepo.findOne({
      where: { id: billingUserId },
      select: ['id', 'companyId'],
    });
    if (!billingReference) {
      throw new InternalServerErrorException('과금 대상 유저가 존재하지 않습니다.');
    }

    if (!billingReference.companyId) {
      const user = await userRepo
        .createQueryBuilder('billingUser')
        .setLock('pessimistic_write')
        .leftJoinAndSelect('billingUser.company', 'billingCompany')
        .where('billingUser.id = :id', { id: billingUserId })
        .getOne();
      if (!user) {
        throw new InternalServerErrorException('과금 대상 유저가 존재하지 않습니다.');
      }
      return { user, companyUsers: [user] };
    }

    const company = await companyRepo
      .createQueryBuilder('company')
      .setLock('pessimistic_write')
      .where('company.id = :id', { id: billingReference.companyId })
      .getOne();
    if (!company) {
      throw new InternalServerErrorException('회사 잔액 처리 중 회사 정보를 찾을 수 없습니다.');
    }

    const companyUsers = await userRepo
      .createQueryBuilder('companyUser')
      .setLock('pessimistic_write')
      .where('companyUser.companyId = :companyId', { companyId: company.id })
      .orderBy('companyUser.id', 'ASC')
      .getMany();
    const user = companyUsers.find((companyUser) => companyUser.id === billingUserId);
    if (!user) {
      throw new InternalServerErrorException('회사 사용자 잠금 처리 중 과금 대상 유저를 찾을 수 없습니다.');
    }
    user.company = company;
    return { user, companyUsers };
  }

  /**
   * 회사 단위 잠금 (회사 row FOR UPDATE → 소속 users FOR UPDATE id-ASC).
   * userId 가 없는 회사 레벨 정산코드 작업(renameCode 등)에서 lock() 와 동일한 잠금 순서를 재사용한다.
   */
  async lockByCompany(
    companyId: number,
    manager: EntityManager,
  ): Promise<{ company: UserCompanyEntity; companyUsers: UserEntity[] }> {
    const companyRepo = manager.getRepository(UserCompanyEntity);
    const userRepo = manager.getRepository(UserEntity);

    const company = await companyRepo
      .createQueryBuilder('company')
      .setLock('pessimistic_write')
      .where('company.id = :id', { id: companyId })
      .getOne();
    if (!company) {
      throw new InternalServerErrorException('회사 잔액 처리 중 회사 정보를 찾을 수 없습니다.');
    }

    const companyUsers = await userRepo
      .createQueryBuilder('companyUser')
      .setLock('pessimistic_write')
      .where('companyUser.companyId = :companyId', { companyId })
      .orderBy('companyUser.id', 'ASC')
      .getMany();

    return { company, companyUsers };
  }
}
