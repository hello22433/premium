import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PinInventoryPolicyEntity } from '../../entity/pin.inventory.policy.entity';
import { DirectPinDeliveryPolicyEntity } from '../../entity/direct.pin.delivery.policy.entity';
import { PIN_INVENTORY_ERROR } from '../domain/inventory.pin.error.codes';

/**
 * 도메인 정책 싱글턴 관리. rev5 §4.10 / plan §DIRECT_PIN.
 *
 * - 행 누락/중복/읽기 실패 → fail closed (allocationEnabled=false, applicationsOpen=false, sendEnabled=false)
 * - 전환은 version CAS + 감사로그
 */
@Injectable()
export class InventoryPinPolicyService {
  private readonly logger = new Logger(InventoryPinPolicyService.name);

  constructor(
    @InjectRepository(PinInventoryPolicyEntity)
    private readonly policyRepo: Repository<PinInventoryPolicyEntity>,
    @InjectRepository(DirectPinDeliveryPolicyEntity)
    private readonly sendPolicyRepo: Repository<DirectPinDeliveryPolicyEntity>,
  ) {}

  /**
   * allocation/applications 정책 읽기 (fail closed).
   */
  async readPolicy(): Promise<{ applicationsOpen: boolean; allocationEnabled: boolean; version: number }> {
    try {
      const row = await this.policyRepo.findOne({ where: { id: 1 } });
      if (!row) {
        this.logger.warn('pin_inventory_policy singleton missing — fail closed');
        return { applicationsOpen: false, allocationEnabled: false, version: 0 };
      }
      return { applicationsOpen: row.applicationsOpen, allocationEnabled: row.allocationEnabled, version: row.version };
    } catch (e) {
      this.logger.error('pin_inventory_policy read failed — fail closed', e);
      return { applicationsOpen: false, allocationEnabled: false, version: 0 };
    }
  }

  /**
   * send 정책 읽기 (fail closed).
   */
  async readSendPolicy(): Promise<{ sendEnabled: boolean; version: number }> {
    try {
      const row = await this.sendPolicyRepo.findOne({ where: { id: 1 } });
      if (!row) {
        this.logger.warn('direct_pin_delivery_policy singleton missing — fail closed');
        return { sendEnabled: false, version: 0 };
      }
      return { sendEnabled: row.sendEnabled, version: row.version };
    } catch (e) {
      this.logger.error('direct_pin_delivery_policy read failed — fail closed', e);
      return { sendEnabled: false, version: 0 };
    }
  }

  /**
   * allocation/applications 정책 토글. version CAS.
   */
  async togglePolicy(
    field: 'applicationsOpen' | 'allocationEnabled',
    value: boolean,
    expectedVersion: number,
    userId: number,
  ): Promise<{ success: boolean; currentVersion: number }> {
    const result = await this.policyRepo
      .createQueryBuilder()
      .update(PinInventoryPolicyEntity)
      .set({
        [field]: value,
        version: () => '`version` + 1',
        updatedByUserId: userId,
      })
      .where('id = :id AND version = :version', { id: 1, version: expectedVersion })
      .execute();

    if (result.affected === 1) {
      return { success: true, currentVersion: expectedVersion + 1 };
    }
    const current = await this.policyRepo.findOne({ where: { id: 1 } });
    return { success: false, currentVersion: current?.version ?? 0 };
  }

  /**
   * send 정책 토글. version CAS.
   */
  async toggleSendPolicy(
    sendEnabled: boolean,
    expectedVersion: number,
    userId: number,
    reason: string,
  ): Promise<{ success: boolean; currentVersion: number }> {
    const result = await this.sendPolicyRepo
      .createQueryBuilder()
      .update(DirectPinDeliveryPolicyEntity)
      .set({
        sendEnabled,
        version: () => '`version` + 1',
        updatedByUserId: userId,
        reason,
      })
      .where('id = :id AND version = :version', { id: 1, version: expectedVersion })
      .execute();

    if (result.affected === 1) {
      return { success: true, currentVersion: expectedVersion + 1 };
    }
    const current = await this.sendPolicyRepo.findOne({ where: { id: 1 } });
    return { success: false, currentVersion: current?.version ?? 0 };
  }

  /**
   * 정책 FOR SHARE 잠금 읽기 (할당 트랜잭션 내).
   */
  async lockPolicyForShare(queryRunner: import('typeorm').QueryRunner): Promise<PinInventoryPolicyEntity | null> {
    const rows = await queryRunner.query(
      'SELECT * FROM `pin_inventory_policy` WHERE `id` = 1 FOR SHARE',
    );
    if (!rows || rows.length === 0) return null;
    return Object.assign(new PinInventoryPolicyEntity(), rows[0]) as PinInventoryPolicyEntity;
  }

  /**
   * send 정책 FOR UPDATE 잠금 읽기 (토글 트랜잭션 내).
   */
  async lockSendPolicyForUpdate(queryRunner: import('typeorm').QueryRunner): Promise<DirectPinDeliveryPolicyEntity | null> {
    const rows = await queryRunner.query(
      'SELECT * FROM `direct_pin_delivery_policy` WHERE `id` = 1 FOR UPDATE',
    );
    if (!rows || rows.length === 0) return null;
    return Object.assign(new DirectPinDeliveryPolicyEntity(), rows[0]) as DirectPinDeliveryPolicyEntity;
  }

  /**
   * send 정책 fail-closed 읽기 (DB 트랜잭션 밖, final fence 전).
   * 정확히 1행 + sendEnabled=true여야 true.
   */
  async readSendPolicyFailClosed(): Promise<{ sendEnabled: boolean; version: number }> {
    try {
      const rows = await this.sendPolicyRepo.find({ where: { id: 1 } });
      if (rows.length !== 1) {
        this.logger.warn(`direct_pin_delivery_policy: expected 1 row, got ${rows.length} — fail closed`);
        return { sendEnabled: false, version: 0 };
      }
      return { sendEnabled: rows[0].sendEnabled, version: rows[0].version };
    } catch (e) {
      this.logger.error('direct_pin_delivery_policy fail-closed read error', e);
      return { sendEnabled: false, version: 0 };
    }
  }
}
