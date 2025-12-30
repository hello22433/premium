import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { DepartmentEntity } from '../../entity/department.entity';
import { UserViewScopeEntity, ViewScopeType } from '../../entity/user.view.scope.entity';
import { UserEntity } from '../../entity/user.entity';
import {
  DepartmentCreateReqDto,
  DepartmentGetListReqDto,
  DepartmentUpdateReqDto,
  UserDepartmentUpdateReqDto,
  ViewScopeUpdateReqDto,
} from '../api/department.req.dto';
import {
  DepartmentGetDetailResDto,
  DepartmentGetListResDto,
  DepartmentViewDto,
  ViewScopeGetResDto,
} from '../api/department.res.dto';
import { format } from 'date-fns';
import { DateFormatStr } from '../../common/domain/date.format.str';

@Injectable()
export class DepartmentService {
  private logger = new Logger('DepartmentService');

  constructor(
    @InjectRepository(DepartmentEntity)
    private departmentRepository: Repository<DepartmentEntity>,
    @InjectRepository(UserViewScopeEntity)
    private userViewScopeRepository: Repository<UserViewScopeEntity>,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

  // ============================================
  // 부서 CRUD
  // ============================================

  async createDepartment(dto: DepartmentCreateReqDto): Promise<void> {
    // 중복 체크 (같은 회사 내 동일 부서명)
    const existing = await this.departmentRepository.findOne({
      where: {
        companyId: dto.companyId,
        name: dto.name,
        deletedAt: IsNull(),
      },
    });

    if (existing) {
      throw new BadRequestException('동일한 부서명이 이미 존재합니다.');
    }

    const department = this.departmentRepository.create({
      companyId: dto.companyId,
      name: dto.name,
    });

    await this.departmentRepository.save(department);
  }

  async updateDepartment(dto: DepartmentUpdateReqDto): Promise<void> {
    const department = await this.departmentRepository.findOne({
      where: { id: dto.id, deletedAt: IsNull() },
    });

    if (!department) {
      throw new BadRequestException('부서를 찾을 수 없습니다.');
    }

    // 같은 회사 내 중복 체크
    const existing = await this.departmentRepository.findOne({
      where: {
        companyId: department.companyId,
        name: dto.name,
        deletedAt: IsNull(),
      },
    });

    if (existing && existing.id !== dto.id) {
      throw new BadRequestException('동일한 부서명이 이미 존재합니다.');
    }

    department.name = dto.name;
    await this.departmentRepository.save(department);
  }

  async deleteDepartment(id: number): Promise<void> {
    const department = await this.departmentRepository.findOne({
      where: { id, deletedAt: IsNull() },
    });

    if (!department) {
      throw new BadRequestException('부서를 찾을 수 없습니다.');
    }

    // 소속 사용자가 있는지 확인
    const userCount = await this.userRepository.count({
      where: { departmentId: id, deletedAt: IsNull() },
    });

    if (userCount > 0) {
      throw new BadRequestException(`해당 부서에 ${userCount}명의 사용자가 소속되어 있습니다. 먼저 사용자를 다른 부서로 이동해주세요.`);
    }

    // Soft delete
    department.deletedAt = new Date();
    await this.departmentRepository.save(department);
  }

  async getDepartmentList(dto: DepartmentGetListReqDto): Promise<DepartmentGetListResDto> {
    const queryBuilder = this.departmentRepository
      .createQueryBuilder('department')
      .leftJoinAndSelect('department.company', 'company')
      .leftJoin('department.users', 'users', 'users.deletedAt IS NULL')
      .addSelect('COUNT(users.id)', 'userCount')
      .where('department.deletedAt IS NULL')
      .groupBy('department.id')
      .addGroupBy('company.id')
      .orderBy('company.businessName', 'ASC')
      .addOrderBy('department.name', 'ASC');

    if (dto.companyId) {
      queryBuilder.andWhere('department.companyId = :companyId', { companyId: dto.companyId });
    }

    const rawResults = await queryBuilder.getRawAndEntities();

    const list: DepartmentViewDto[] = rawResults.entities.map((department, index) => ({
      id: department.id,
      companyId: department.companyId,
      companyName: department.company?.businessName ?? '',
      name: department.name,
      userCount: parseInt(rawResults.raw[index].userCount, 10) || 0,
      createdAt: format(department.createdAt, DateFormatStr),
    }));

    return { list };
  }

  async getDepartmentDetail(id: number): Promise<DepartmentGetDetailResDto> {
    const department = await this.departmentRepository.findOne({
      where: { id, deletedAt: IsNull() },
      relations: ['company', 'users'],
    });

    if (!department) {
      throw new BadRequestException('부서를 찾을 수 없습니다.');
    }

    const activeUsers = (department.users || []).filter((u) => !u.deletedAt);

    return {
      id: department.id,
      companyId: department.companyId,
      companyName: department.company?.businessName ?? '',
      name: department.name,
      userCount: activeUsers.length,
      createdAt: format(department.createdAt, DateFormatStr),
      users: activeUsers.map((user) => ({
        id: user.id,
        email: user.email,
        personName: user.personName,
      })),
    };
  }

  // ============================================
  // 사용자 부서 배정
  // ============================================

  async updateUserDepartment(dto: UserDepartmentUpdateReqDto): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: dto.userId, deletedAt: IsNull() },
    });

    if (!user) {
      throw new BadRequestException('사용자를 찾을 수 없습니다.');
    }

    // 부서 ID가 있으면 존재 여부 확인
    if (dto.departmentId) {
      const department = await this.departmentRepository.findOne({
        where: { id: dto.departmentId, deletedAt: IsNull() },
      });

      if (!department) {
        throw new BadRequestException('부서를 찾을 수 없습니다.');
      }

      // 사용자 회사와 부서 회사가 일치하는지 확인
      if (user.companyId && department.companyId !== user.companyId) {
        throw new BadRequestException('사용자 소속 회사와 부서 소속 회사가 일치하지 않습니다.');
      }
    }

    user.departmentId = dto.departmentId ?? null;
    await this.userRepository.save(user);
  }

  // ============================================
  // 조회 범위 설정
  // ============================================

  async getViewScope(userId: number): Promise<ViewScopeGetResDto> {
    const user = await this.userRepository.findOne({
      where: { id: userId, deletedAt: IsNull() },
    });

    if (!user) {
      throw new BadRequestException('사용자를 찾을 수 없습니다.');
    }

    let viewScope = await this.userViewScopeRepository.findOne({
      where: { userId },
    });

    // 없으면 기본값 반환
    if (!viewScope) {
      return {
        userId,
        scopeType: ViewScopeType.SELF,
        deptIds: [],
        departments: [],
      };
    }

    const deptIds = viewScope.getDeptIdList();
    let departments: { id: number; name: string; companyName: string }[] = [];

    if (deptIds.length > 0) {
      const deptEntities = await this.departmentRepository.find({
        where: deptIds.map((id) => ({ id, deletedAt: IsNull() })),
        relations: ['company'],
      });

      departments = deptEntities.map((d) => ({
        id: d.id,
        name: d.name,
        companyName: d.company?.businessName ?? '',
      }));
    }

    return {
      userId,
      scopeType: viewScope.scopeType,
      deptIds,
      departments,
    };
  }

  async updateViewScope(dto: ViewScopeUpdateReqDto): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { id: dto.userId, deletedAt: IsNull() },
    });

    if (!user) {
      throw new BadRequestException('사용자를 찾을 수 없습니다.');
    }

    let viewScope = await this.userViewScopeRepository.findOne({
      where: { userId: dto.userId },
    });

    const deptIdsString = dto.deptIds && dto.deptIds.length > 0 ? dto.deptIds.join(',') : null;

    if (!viewScope) {
      // 생성
      viewScope = this.userViewScopeRepository.create({
        userId: dto.userId,
        scopeType: dto.scopeType,
        deptIds: deptIdsString,
      });
    } else {
      // 업데이트
      viewScope.scopeType = dto.scopeType;
      viewScope.deptIds = deptIdsString;
    }

    await this.userViewScopeRepository.save(viewScope);
  }
}