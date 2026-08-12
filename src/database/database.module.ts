import { join } from 'path';

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { addTransactionalDataSource, getDataSourceByName } from 'typeorm-transactional';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { SqlLogger } from '../common/api/sql.logger';
import { GemteckMsgQueueEntity } from '../entity/gemtek/msg.queue.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql',
        host: configService.get('DATABASE_HOST'),
        port: +configService.get('DATABASE_PORT'),
        username: configService.get('DATABASE_USERNAME'),
        password: configService.get('DATABASE_PASSWORD'),
        database: configService.get('DATABASE_DATABASE'),
        // 엔티티는 파일 글롭으로 로드한다. 수동 나열은 신규 엔티티 등록 누락(EntityMetadataNotFoundError)을 반복해서 냈다.
        // src/entity/ 직하만 매칭하므로 gemtek(mssql) 전용 엔티티는 이 커넥션에 붙지 않는다.
        entities: [join(__dirname, '..', 'entity', '*.entity.{ts,js}')],
        extra: {
          connectionLimit: +configService.get('DATABASE_CONNECTION_LIMIT', 50),
        },
        timezone: '+09:00',
        logger: configService.get('DATABASE_LOGGING') === 'true' ? new SqlLogger() : undefined,
        namingStrategy: new SnakeNamingStrategy(),
        logging: configService.get('DATABASE_LOGGING') === 'true',
        synchronize: configService.get('DATABASE_SYNCHRONIZE') === 'true',
      }),
      async dataSourceFactory(options) {
        if (!options) {
          throw new Error('Invalid options passed');
        }

        const existingDataSource = getDataSourceByName('default');
        if (existingDataSource) {
          return existingDataSource;
        }

        return addTransactionalDataSource(new DataSource(options));
      },
    }),
    TypeOrmModule.forRootAsync({
      name: 'gemtek_sms',
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mssql',
        host: configService.get('DATABASE_GEMTEK_SMS_HOST'),
        port: +configService.get('DATABASE_GEMTEK_SMS_PORT'),
        username: configService.get('DATABASE_GEMTEK_SMS_USERNAME'),
        password: configService.get('DATABASE_GEMTEK_SMS_PASSWORD'),
        database: configService.get('DATABASE_GEMTEK_SMS_DATABASE'),
        entities: [GemteckMsgQueueEntity],
        logging: configService.get('DATABASE_LOGGING') === 'true',
        synchronize: false,
        options: {
          encrypt: false, // TLS 암호화 비활성화
          trustServerCertificate: true, // 인증서 검증 무시
          // MSG_QUEUE(EXT_COL2) 필터드 unique index 가 적용되면 INSERT 세션도 QUOTED_IDENTIFIER/ARITHABORT ON
          // 이어야 하고, 아니면 발송 INSERT 가 오류 1934 로 전면 실패한다. 드라이버 기본값에 의존하지 않고 명시한다.
          // (plans/프리미엄_발송실패_재발송_구상.md §9 Gemtek DBA 계약 — 인덱스 적용 전 코드 선반영)
          enableArithAbort: true,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
