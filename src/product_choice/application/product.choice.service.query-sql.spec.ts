import 'reflect-metadata';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { SnakeNamingStrategy } from 'typeorm-naming-strategies';
import { ProductEntity } from '../../entity/product.entity';
import { IProductType } from '../../product/interface/product.type';

// 삭제된 구성상품 처리 방식은 TypeORM 이 만드는 JOIN ON 절에 달려 있다.
// 목(mock) 저장소는 조회 결과를 직접 주입하므로 조인 종류를 바꿔도 통과해 버린다.
// 실제 QueryBuilder 로 SQL 을 만들어 ON 절을 직접 확인한다. DB 연결은 필요 없다.
describe('초이스쿠폰 조회 쿼리 SQL - 삭제된 구성상품 처리', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'mysql',
      host: 'localhost',
      database: 'sql-build-only',
      entities: [path.join(process.cwd(), 'src/**/*.entity.ts')],
      namingStrategy: new SnakeNamingStrategy(),
    });

    // 연결 없이 메타데이터만 만든다.
    await (dataSource as any).buildMetadatas();
    // 엔티티 전체를 스캔하므로 병렬 실행 시 기본 5초를 넘길 수 있다.
  }, 60_000);

  // getList 는 구성상품을 left join 으로 가져와야 한다.
  // inner join 이면 삭제된 구성상품이 조인에서 빠져 남은 상품만으로 정상처럼 보이거나,
  // 구성상품이 전부 삭제된 초이스쿠폰 행 자체가 목록에서 사라진다.
  const buildGetListSql = () =>
    dataSource
      .getRepository(ProductEntity)
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.productChoiceMappings', 'productChoiceMappings')
      .leftJoinAndSelect('productChoiceMappings.product', 'subProduct')
      .andWhere('product.type = :type', { type: IProductType.CHOICE })
      .getSql();

  describe('getList', () => {
    it('구성상품을 left join 으로 가져와 삭제된 구성상품이 행을 지우지 않는다', () => {
      const sql = buildGetListSql();

      expect(sql).toContain('LEFT JOIN `product_choice_mapping` `productChoiceMappings`');
      expect(sql).toContain('LEFT JOIN `product` `subProduct`');
      expect(sql).not.toContain('INNER JOIN `product` `subProduct`');
    });

    // withDeleted 를 쓰지 않으므로 삭제된 구성상품은 ON 절에서 걸러져 product 가 null 이 된다.
    // hasUnusedComponent 가 그 null 을 비정상으로 판정하는 구조라 이 조건이 필요하다.
    it('구성상품 join 에 soft-delete 제외 조건이 붙는다', () => {
      const sql = buildGetListSql();

      expect(sql).toContain('`subProduct`.`deleted_at` IS NULL');
    });
  });

  // getDetail 은 목록과 달리 withDeleted 로 삭제된 구성상품까지 읽는다.
  // 어떤 상품이 빠졌는지 응답에 실어야 관리자가 교체 대상을 알 수 있기 때문이다.
  const buildGetDetailSql = () =>
    dataSource
      .getRepository(ProductEntity)
      .createQueryBuilder('product')
      .withDeleted()
      .leftJoinAndSelect('product.productChoiceMappings', 'productChoiceMappings')
      .leftJoinAndSelect('productChoiceMappings.product', 'subProduct')
      .leftJoinAndSelect('subProduct.brand', 'brand')
      .andWhere('product.type = :type', { type: IProductType.CHOICE })
      .andWhere('product.id = :id', { id: 1 })
      .andWhere('product.deletedAt IS NULL')
      .andWhere('productChoiceMappings.deletedAt IS NULL')
      .getSql();

  describe('getDetail', () => {
    // inner join 이면 구성상품이 전부 삭제된 초이스쿠폰이 조회되지 않아
    // 실제로 존재하는 쿠폰에 "존재하지 않는 초이스쿠폰입니다" 가 뜬다.
    it('구성상품과 브랜드를 left join 으로 가져온다', () => {
      const sql = buildGetDetailSql();

      expect(sql).toContain('LEFT JOIN `product_choice_mapping` `productChoiceMappings`');
      expect(sql).toContain('LEFT JOIN `product` `subProduct`');
      expect(sql).toContain('LEFT JOIN `brand` `brand`');
      expect(sql).not.toContain('INNER JOIN `product` `subProduct`');
      expect(sql).not.toContain('INNER JOIN `brand` `brand`');
    });

    // 목록과 반대로 삭제된 구성상품이 조인에서 살아남아야 isDeleted 로 표시할 수 있다.
    it('구성상품 join 에 soft-delete 제외 조건이 붙지 않는다', () => {
      const sql = buildGetDetailSql();

      expect(sql).not.toContain('`subProduct`.`deleted_at` IS NULL');
    });

    // withDeleted 는 쿼리 전체의 soft-delete 필터를 끈다.
    // 초이스쿠폰 본체와 매핑은 조건을 직접 걸어야 삭제된 쿠폰이 상세로 열리지 않는다.
    it('초이스쿠폰 본체와 매핑에는 삭제 제외 조건을 직접 건다', () => {
      const sql = buildGetDetailSql();

      expect(sql).toContain('`product`.`deleted_at` IS NULL');
      expect(sql).toContain('`productChoiceMappings`.`deleted_at` IS NULL');
    });
  });
});
