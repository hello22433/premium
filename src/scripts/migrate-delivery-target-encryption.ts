import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { OrderDeliveryEntity } from '../entity/order.delivery.entity';
import { Repository } from 'typeorm';
import { CryptoCipher } from '../common/infra/crypto.cipher';
import { PhoneUtil } from '../common/utils/phone.util';

/**
 * deliveryTarget 평문 데이터를 암호화하는 마이그레이션 스크립트
 *
 * 실행 방법:
 * npx ts-node src/scripts/migrate-delivery-target-encryption.ts
 */
async function migrate() {
  const app = await NestFactory.createApplicationContext(AppModule);

  const orderDeliveryRepository = app.get<Repository<OrderDeliveryEntity>>('OrderDeliveryEntityRepository');
  const cryptoCipher = app.get(CryptoCipher);

  console.log('Starting deliveryTarget encryption migration...');

  // 모든 order_delivery 레코드 조회
  const deliveries = await orderDeliveryRepository.find();
  console.log(`Found ${deliveries.length} delivery records to migrate`);

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const delivery of deliveries) {
    try {
      const originalTarget = delivery.deliveryTarget;

      // 이미 암호화된 데이터인지 확인 (Base64 형식 체크)
      // Base64는 일반적으로 길이가 길고 특정 문자셋만 사용
      const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
      if (base64Pattern.test(originalTarget) && originalTarget.length > 20) {
        console.log(`Skipping already encrypted delivery ID: ${delivery.id}`);
        skippedCount++;
        continue;
      }

      // 1. 전화번호 정규화 (하이픈 제거)
      const normalized = PhoneUtil.normalizeDeliveryTarget(originalTarget);

      // 2. 암호화
      const encrypted = cryptoCipher.encryptDeliveryTarget(normalized);

      // 3. 업데이트
      delivery.deliveryTarget = encrypted;
      await orderDeliveryRepository.save(delivery);

      successCount++;
      console.log(`Migrated delivery ID: ${delivery.id} (${originalTarget} -> encrypted)`);
    } catch (error) {
      errorCount++;
      console.error(`Error migrating delivery ID: ${delivery.id}`, error.message);
    }
  }

  console.log('\n=== Migration Summary ===');
  console.log(`Total records: ${deliveries.length}`);
  console.log(`Successfully migrated: ${successCount}`);
  console.log(`Skipped (already encrypted): ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);

  await app.close();
}

migrate()
  .then(() => {
    console.log('Migration completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
