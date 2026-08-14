import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transactional } from 'typeorm-transactional';
import { PartnerCreditConfigEntity } from '../../entity/partner.credit.config.entity';
import { PartnerCreditConfigHistoryEntity } from '../../entity/partner.credit.config.history.entity';
import { PartnerCompanyEntity } from '../../entity/partner.company.entity';
import { IPartnerCompanyType } from '../../partner_company/interface/partner.company.type';
import { CreditAmountFormatError, parseNonNegativeAmount, serializeAmount } from '../domain/credit.amount.string';
import {
  calculateMonthlyLimit,
  isSupportedCreditPartnerType,
  UnsupportedCreditPartnerTypeError,
} from '../domain/credit.monthly.limit';
import { ConfigVersionConflictError, decideConfigMutation } from '../domain/credit.config.decision';
import { isValidCreditSubItemKey } from '../domain/credit.row.axis';
import { isDuplicateKeyError } from './partner.settle.raw.insert';

/** GET 응답 1행 (금액은 canonical 문자열). */
export type CreditConfigView = {
  subItemKey: string;
  insuranceAmount: string;
  prepaidAmount: string;
  etcAmount: string;
  monthlyLimit: string;
  version: number;
};

/** PUT 요청 1건. 금액은 canonical 음수불허 문자열, expectedVersion 은 최초 생성 null·갱신 정수. */
export type CreditConfigPutItem = {
  subItemKey: string;
  insuranceAmount: string;
  prepaidAmount: string;
  etcAmount: string;
  expectedVersion: number | null;
};

export type CreditConfigPutResult = { subItemKey: string; version: number };

type ParsedItem = {
  subItemKey: string;
  insuranceAmount: bigint;
  prepaidAmount: bigint;
  etcAmount: bigint;
  expectedVersion: number | null;
};

/**
 * 협력사 여신 설정 조회/변경 (정본 §5.3 · §9 credit/config · §4.4).
 *
 * 변경은 config row `FOR UPDATE` → 이전값 history append → 현재값 갱신(+version)을 **한 트랜잭션**으로
 * 처리하고, `expectedVersion` 불일치를 409 로 거부한다(3차 M3 · 21차 M1 · 33차-H6).
 */
@Injectable()
export class PartnerCreditConfigService {
  constructor(
    @InjectRepository(PartnerCreditConfigEntity)
    private readonly configRepository: Repository<PartnerCreditConfigEntity>,
    @InjectRepository(PartnerCreditConfigHistoryEntity)
    private readonly historyRepository: Repository<PartnerCreditConfigHistoryEntity>,
    @InjectRepository(PartnerCompanyEntity)
    private readonly partnerRepository: Repository<PartnerCompanyEntity>,
  ) {}

  /** 하위항목별 config + 계산된 월 한도 + version. */
  async getConfig(partnerCompanyId: number): Promise<CreditConfigView[]> {
    const partnerType = await this.loadPartnerType(partnerCompanyId);
    const rows = await this.configRepository.find({
      where: { partnerCompanyId },
      order: { subItemKey: 'ASC' },
    });

    return rows.map((row) => {
      const amounts = {
        insuranceAmount: BigInt(row.insuranceAmount),
        prepaidAmount: BigInt(row.prepaidAmount),
        etcAmount: BigInt(row.etcAmount),
      };
      return {
        subItemKey: row.subItemKey,
        insuranceAmount: serializeAmount(amounts.insuranceAmount),
        prepaidAmount: serializeAmount(amounts.prepaidAmount),
        etcAmount: serializeAmount(amounts.etcAmount),
        monthlyLimit: serializeAmount(this.monthlyLimit(partnerType, amounts, row.subItemKey)),
        version: row.version,
      };
    });
  }

  /**
   * all-or-nothing 배치 갱신. 한 item 이라도 실패하면 전체 rollback.
   * 잠금 순서는 `subItemKey` 오름차순으로 고정해 배치 간 데드락을 막는다.
   */
  @Transactional()
  async putConfig(
    partnerCompanyId: number,
    items: CreditConfigPutItem[],
    changedBy: number,
  ): Promise<CreditConfigPutResult[]> {
    const partnerType = await this.loadPartnerType(partnerCompanyId); // 협력사 존재 검증(없으면 404)
    if (!isSupportedCreditPartnerType(partnerType)) {
      // 비대상 type 에 설정을 만들면 이후 GET 이 월한도 계산에서 400 으로 깨진다(쓰기 성공·읽기 불능).
      throw new BadRequestException(`여신 표 대상 협력사가 아닙니다 (type=${partnerType})`);
    }

    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('items 는 1건 이상이어야 합니다.');
    }
    const parsed = this.parseItems(items);
    if (partnerType === IPartnerCompanyType.GALAXIA) {
      for (const item of parsed) {
        if (!isValidCreditSubItemKey(partnerType, item.subItemKey)) {
          throw new BadRequestException(
            `여신 표 하위항목이 아닙니다 (type=${partnerType}, subItemKey=${item.subItemKey})`,
          );
        }
      }
    }
    const changedAt = new Date();

    const results: CreditConfigPutResult[] = [];
    for (const item of parsed) {
      results.push(await this.upsertOne(partnerCompanyId, item, changedBy, changedAt));
    }
    return results;
  }

  private async upsertOne(
    partnerCompanyId: number,
    item: ParsedItem,
    changedBy: number,
    changedAt: Date,
  ): Promise<CreditConfigPutResult> {
    const existing = await this.configRepository
      .createQueryBuilder('config')
      .setLock('pessimistic_write')
      .where('config.partnerCompanyId = :partnerCompanyId', { partnerCompanyId })
      .andWhere('config.subItemKey = :subItemKey', { subItemKey: item.subItemKey })
      .getOne();

    const mutation = this.decide(existing ? existing.version : null, item.expectedVersion, item.subItemKey);

    if (mutation.kind === 'UPDATE' && existing) {
      await this.appendHistory(partnerCompanyId, item, 'UPDATE', existing, changedBy, changedAt);
      await this.configRepository.update(existing.id, {
        insuranceAmount: serializeAmount(item.insuranceAmount),
        prepaidAmount: serializeAmount(item.prepaidAmount),
        etcAmount: serializeAmount(item.etcAmount),
        version: mutation.nextVersion,
      });
      return { subItemKey: item.subItemKey, version: mutation.nextVersion };
    }

    try {
      await this.configRepository.insert({
        partnerCompanyId,
        subItemKey: item.subItemKey,
        insuranceAmount: serializeAmount(item.insuranceAmount),
        prepaidAmount: serializeAmount(item.prepaidAmount),
        etcAmount: serializeAmount(item.etcAmount),
        version: 0,
      });
    } catch (error) {
      // 동시 최초 생성 경합 — UNIQUE(partnerCompanyId, subItemKey) 패자는 409.
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(`여신 설정 최초 생성 경합 (subItemKey=${item.subItemKey})`);
      }
      throw error;
    }
    await this.appendHistory(partnerCompanyId, item, 'CREATE', null, changedBy, changedAt);
    return { subItemKey: item.subItemKey, version: 0 };
  }

  private decide(existingVersion: number | null, expectedVersion: number | null, subItemKey: string) {
    try {
      return decideConfigMutation(existingVersion, expectedVersion);
    } catch (error) {
      if (error instanceof ConfigVersionConflictError) {
        throw new ConflictException(`${error.message} (subItemKey=${subItemKey})`);
      }
      throw error;
    }
  }

  private async appendHistory(
    partnerCompanyId: number,
    item: ParsedItem,
    action: 'CREATE' | 'UPDATE',
    before: PartnerCreditConfigEntity | null,
    changedBy: number,
    changedAt: Date,
  ): Promise<void> {
    await this.historyRepository.insert({
      partnerCompanyId,
      subItemKey: item.subItemKey,
      action,
      beforeInsuranceAmount: before ? before.insuranceAmount : null,
      beforePrepaidAmount: before ? before.prepaidAmount : null,
      beforeEtcAmount: before ? before.etcAmount : null,
      afterInsuranceAmount: serializeAmount(item.insuranceAmount),
      afterPrepaidAmount: serializeAmount(item.prepaidAmount),
      afterEtcAmount: serializeAmount(item.etcAmount),
      changedBy,
      changedAt,
    });
  }

  private parseItems(items: CreditConfigPutItem[]): ParsedItem[] {
    const seen = new Set<string>();
    const parsed = items.map((item) => {
      const subItemKey = (item.subItemKey ?? '').trim();
      if (!subItemKey) throw new BadRequestException('subItemKey 는 필수입니다.');
      if (seen.has(subItemKey)) {
        throw new BadRequestException(`배치에 중복 subItemKey 가 있습니다: ${subItemKey}`);
      }
      seen.add(subItemKey);
      if (item.expectedVersion !== null && !Number.isInteger(item.expectedVersion)) {
        throw new BadRequestException(`expectedVersion 은 null 또는 정수여야 합니다 (${subItemKey})`);
      }
      try {
        return {
          subItemKey,
          insuranceAmount: parseNonNegativeAmount(item.insuranceAmount, 'insuranceAmount'),
          prepaidAmount: parseNonNegativeAmount(item.prepaidAmount, 'prepaidAmount'),
          etcAmount: parseNonNegativeAmount(item.etcAmount, 'etcAmount'),
          expectedVersion: item.expectedVersion,
        };
      } catch (error) {
        if (error instanceof CreditAmountFormatError) throw new BadRequestException(error.message);
        throw error;
      }
    });
    // 잠금 순서 고정 (subItemKey 오름차순).
    return parsed.sort((a, b) => (a.subItemKey < b.subItemKey ? -1 : a.subItemKey > b.subItemKey ? 1 : 0));
  }

  private monthlyLimit(
    partnerType: IPartnerCompanyType,
    amounts: { insuranceAmount: bigint; prepaidAmount: bigint; etcAmount: bigint },
    subItemKey?: string,
  ): bigint {
    try {
      return calculateMonthlyLimit(partnerType, amounts, subItemKey);
    } catch (error) {
      if (error instanceof UnsupportedCreditPartnerTypeError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async loadPartnerType(partnerCompanyId: number): Promise<IPartnerCompanyType> {
    const partner = await this.partnerRepository.findOne({
      where: { id: partnerCompanyId },
      select: ['id', 'type'],
    });
    if (!partner) throw new NotFoundException(`협력사를 찾을 수 없습니다 (id=${partnerCompanyId})`);
    if (!partner.type) {
      throw new BadRequestException(`협력사 type 이 없습니다 (id=${partnerCompanyId})`);
    }
    return partner.type;
  }
}
