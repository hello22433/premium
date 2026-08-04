import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 협력사 정산조건 scope 잠금 앵커.
 *
 * 값 필드가 없는 불변 row 다. `INSERT ... IGNORE` 로 upsert 한 뒤 그 row 를 `FOR UPDATE` 로 잡아
 * 이력/예약 쓰기를 직렬화한다. history row 가 0개인 신규 scope 도 앵커는 항상 존재하므로
 * 최초 동시 쓰기에서 open 구간이 2개 생기는 것을 막는다.
 *
 * `scopeKey` 는 접두어로 네임스페이스가 갈린다.
 * - `sk1|...` = canonical scopeKey (scope 8필드)
 * - `pt1|...` = policyTargetKey (method/range/compareCondition 제외한 넓은 대상)
 */
// UNIQUE 가 없으면 `INSERT ... IGNORE` 가 중복 앵커를 만들어 두 요청이 서로 다른 행을 잠근다.
// 그러면 직렬화 자체가 성립하지 않으므로 엔티티에도 선언해 schema-sync 환경까지 같은 보장을 유지한다.
@Index('uk_partner_discount_scope_key', ['scopeKey'], { unique: true })
@Entity('partner_discount_scope')
export class PartnerDiscountScopeEntity {
  @PrimaryGeneratedColumn()
  id: number;

  // canonical key 는 binary 비교 계약이다. 기본 대조(utf8mb4_unicode_ci)를 쓰면 대소문자·유니코드 동치가
  // 같은 키로 뭉쳐 잠금 단위와 유일성이 배포 DDL 과 달라진다.
  @Column({
    type: 'varchar',
    length: 255,
    charset: 'utf8mb4',
    collation: 'utf8mb4_bin',
    comment: 'canonical scopeKey(sk1|...) 또는 policyTargetKey(pt1|...)',
  })
  scopeKey: string;

  @CreateDateColumn()
  createdAt: Date;
}
