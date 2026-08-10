import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ExternalApiPinInventoryRequestEntity } from '../../entity/external.api.pin.inventory.request.entity';
import { ApiAppEntity } from '../../entity/api.app.entity';
import { PinInventoryPolicyEntity } from '../../entity/pin.inventory.policy.entity';
import { InventoryPinPolicyService } from './inventory.pin.policy.service';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';

/**
 * 외부 API 재고형 쿠폰 신청/승인/철회 서비스. rev5 §11.1–§11.3.
 *
 * - 신청: api_app → pin_inventory_policy 순서로 잠금
 * - 승인: app row 잠금 → request 상태 CAS + entitlement 변경
 * - 철회: app row 잠금 → pinInventoryEnabled=false + 사유
 */
@Injectable()
export class InventoryPinRequestService {
  private readonly logger = new Logger(InventoryPinRequestService.name);

  constructor(
    @InjectRepository(ExternalApiPinInventoryRequestEntity)
    private readonly requestRepo: Repository<ExternalApiPinInventoryRequestEntity>,
    @InjectRepository(ApiAppEntity)
    private readonly appRepo: Repository<ApiAppEntity>,
    private readonly policyService: InventoryPinPolicyService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 신청 접수. rev5 §11.1.
   * 잠금 순서: api_app → pin_inventory_policy
   */
  async submit(userId: number, reason: string): Promise<ExternalApiPinInventoryRequestEntity> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. 인증 계정의 app FOR UPDATE
      const apps = await queryRunner.query(
        `SELECT * FROM \`api_app\`
         WHERE \`default_billing_user_id\` = ? AND \`is_active\` = 1
         FOR UPDATE`,
        [userId],
      );
      if (!apps?.length) throw new BadRequestException('active app not found');
      const app = apps[0];

      if (app.pin_inventory_enabled) {
        throw new BadRequestException('already approved');
      }

      // 2. policy FOR UPDATE
      const policies = await queryRunner.query(
        'SELECT * FROM `pin_inventory_policy` WHERE `id` = 1 FOR UPDATE',
      );
      if (!policies?.length || !policies[0].applications_open) {
        throw new BadRequestException(PIN_INVENTORY_ERROR.APPLICATIONS_CLOSED);
      }

      // 3. PENDING request insert (generated UNIQUE가 중복 차단)
      try {
        const result = await queryRunner.query(
          `INSERT INTO \`external_api_pin_inventory_request\`
           (\`api_app_id\`, \`status\`, \`requested_by_user_id\`, \`request_reason\`,
            \`created_at\`, \`updated_at\`)
           VALUES (?, 'PENDING', ?, ?, NOW(6), NOW(6))`,
          [app.id, userId, reason],
        );
        await queryRunner.commitTransaction();
        return this.requestRepo.findOneOrFail({ where: { id: String(result.insertId) } });
      } catch (err: any) {
        if (err?.code === 'ER_DUP_ENTRY') {
          throw new BadRequestException(PIN_INVENTORY_ERROR.REQUEST_CONFLICT);
        }
        throw err;
      }
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async listByUser(userId: number): Promise<ExternalApiPinInventoryRequestEntity[]> {
    // user의 app 조회 후 해당 app의 request 목록
    const app = await this.appRepo.findOne({ where: { defaultBillingUserId: userId, isActive: true } });
    if (!app) return [];
    return this.requestRepo.find({
      where: { apiAppId: app.id },
      order: { id: 'DESC' },
    });
  }

  async listAll(): Promise<ExternalApiPinInventoryRequestEntity[]> {
    return this.requestRepo.find({ order: { id: 'DESC' }, take: 100 });
  }

  /**
   * 본인 PENDING 신청 취소.
   */
  async cancel(requestId: string, userId: number): Promise<{ success: boolean }> {
    const result = await this.requestRepo
      .createQueryBuilder()
      .update(ExternalApiPinInventoryRequestEntity)
      .set({ status: 'CANCELLED', decidedByUserId: userId, decidedAt: new Date() })
      .where('id = :id AND status = :status AND requestedByUserId = :userId', {
        id: requestId, status: 'PENDING', userId,
      })
      .execute();
    if (result.affected !== 1) throw new BadRequestException(PIN_INVENTORY_ERROR.REQUEST_CONFLICT);
    return { success: true };
  }

  /**
   * 관리자 승인. rev5 §11.1.
   * PENDING CAS + 같은 TX에서 api_app.pinInventoryEnabled=true
   */
  async approve(requestId: string, operatorUserId: number, reason?: string): Promise<{ success: boolean }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // request 조회
      const [request] = await queryRunner.query(
        'SELECT * FROM `external_api_pin_inventory_request` WHERE `id` = ? FOR UPDATE',
        [requestId],
      );
      if (!request || request.status !== 'PENDING') {
        throw new BadRequestException(PIN_INVENTORY_ERROR.REQUEST_CONFLICT);
      }

      // app 잠금 + entitlement 변경
      await queryRunner.query(
        `UPDATE \`api_app\` SET \`pin_inventory_enabled\` = 1 WHERE \`id\` = ?`,
        [request.api_app_id],
      );

      // request APPROVED
      await queryRunner.query(
        `UPDATE \`external_api_pin_inventory_request\`
         SET \`status\` = 'APPROVED', \`decided_by_user_id\` = ?, \`decision_reason\` = ?, \`decided_at\` = NOW(6)
         WHERE \`id\` = ? AND \`status\` = 'PENDING'`,
        [operatorUserId, reason ?? null, requestId],
      );

      await queryRunner.commitTransaction();
      return { success: true };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * 관리자 거절.
   */
  async reject(requestId: string, operatorUserId: number, reason: string): Promise<{ success: boolean }> {
    const result = await this.requestRepo
      .createQueryBuilder()
      .update(ExternalApiPinInventoryRequestEntity)
      .set({
        status: 'REJECTED',
        decidedByUserId: operatorUserId,
        decisionReason: reason,
        decidedAt: new Date(),
      })
      .where('id = :id AND status = :status', { id: requestId, status: 'PENDING' })
      .execute();
    if (result.affected !== 1) throw new BadRequestException(PIN_INVENTORY_ERROR.REQUEST_CONFLICT);
    return { success: true };
  }

  /**
   * 승인 철회. rev5 §11.1.
   * 별도 관리자 작업으로 entitlement=false + 사유.
   */
  async revoke(appId: string, operatorUserId: number, reason: string): Promise<{ success: boolean }> {
    const result = await this.appRepo
      .createQueryBuilder()
      .update(ApiAppEntity)
      .set({ pinInventoryEnabled: false })
      .where('id = :id AND pinInventoryEnabled = :enabled', { id: appId, enabled: true })
      .execute();
    if (result.affected !== 1) throw new BadRequestException('already revoked or app not found');
    this.logger.log(`PIN_INVENTORY_REVOKE: appId=${appId} by=${operatorUserId} reason="${reason}"`);
    return { success: true };
  }

  async getPolicy() {
    return this.policyService.readPolicy();
  }

  async updatePolicy(
    field: 'applicationsOpen' | 'allocationEnabled',
    value: boolean,
    expectedVersion: number,
    userId: number,
  ) {
    return this.policyService.togglePolicy(field, value, expectedVersion, userId);
  }
}
