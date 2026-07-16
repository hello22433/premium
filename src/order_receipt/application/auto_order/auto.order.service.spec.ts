import * as ExcelJS from 'exceljs';
import { Repository } from 'typeorm';
import { AutoOrderService } from './auto.order.service';
import { AutoOrderExcelParser } from './auto.order.excel.parser';
import { AutoOrderStructureValidator } from './auto.order.structure.validator';
import { AutoOrderProductMapper } from './auto.order.product.mapper';
import { AutoOrderPreValidator } from './auto.order.pre.validator';
import { AutoOrderPayloadBuilder } from './auto.order.payload.builder';
import { FileService } from '../../../file/application/file.service';
import { ForbiddenWordMatcher } from '../../../forbidden_word/application/forbidden.word.matcher';
import { ProductEntity } from '../../../entity/product.entity';
import { UserEntity } from '../../../entity/user.entity';
import { SsgReservationRangeEntity } from '../../../entity/ssg.reservation.range.entity';
import { OrderReceiptEntity } from '../../../entity/order.receipt.entity';
import { IProductType } from '../../../product/interface/product.type';
import { ILoginUserInfo } from '../../../auth/interface/login.user';
import { AutoOrderRunMode } from './auto.order.types';

/** 상품 마스터(코드→타입) */
const MASTER: Record<string, IProductType> = {
  'GEN-1': IProductType.GENERAL,
  'SSG-1': IProductType.SSG,
};

type RowInput = { b?: string; d?: string; code?: string; valid?: boolean; rep1?: string };

/** 채워진 v4.1 버퍼 생성 (수식 셀은 캐시결과 포함) */
async function buildFilledBuffer(rows: RowInput[], formVersion = 'v4.1-immediate-send'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('1.신청정보');
  info.getCell('C1').value = formVersion;
  info.getCell('C16').value = 'TRUE'; // 즉시발송(SSG 예약창 검사 회피)
  info.getCell('C19').value = '이벤트';
  info.getCell('C20').value = '제목';
  info.getCell('C21').value = '내용';
  info.getCell('C23').value = '문자';
  info.getCell('C24').value = '1644-3614';
  info.getCell('C25').value = 90;

  const list = wb.addWorksheet('2.발송명단');
  const f = (formula: string, result: unknown) => ({ formula, result }) as ExcelJS.CellFormulaValue;
  rows.forEach((r, i) => {
    const rn = 5 + i;
    if (r.b !== undefined) list.getCell(`B${rn}`).value = r.b;
    if (r.d !== undefined) list.getCell(`D${rn}`).value = r.d;
    list.getCell(`H${rn}`).value = f('INDEX(...)', r.code ?? '');
    list.getCell(`J${rn}`).value = f('IF(...)', 1);
    list.getCell(`M${rn}`).value = f('AND(...)', r.valid ?? true);
    list.getCell(`N${rn}`).value = f('IF(...)', (r.valid ?? true) ? 'ok' : 'duplicate');
    if (r.rep1 !== undefined) list.getCell(`P${rn}`).value = r.rep1;
  });
  return (await wb.xlsx.writeBuffer()) as Buffer;
}

function makeService(bufferByUrl: Record<string, Buffer>): AutoOrderService {
  const productRepo = {
    find: async () =>
      Object.entries(MASTER).map(([code, type], i) => ({ id: i + 1, code, type, price: 5000 }) as ProductEntity),
  } as unknown as Repository<ProductEntity>;

  const userRepo = {
    findOne: async () => ({ id: 10, allowedSendMethods: null }) as unknown as UserEntity,
  } as unknown as Repository<UserEntity>;

  const rangeRepo = {
    findOne: async () => null,
  } as unknown as Repository<SsgReservationRangeEntity>;

  const fileService = {
    getBuffer: async (url: string) => bufferByUrl[url],
    extractOriginalFileName: (url: string) => url.split('/').pop() ?? url,
  } as unknown as FileService;

  const matcher = {
    scan: (t?: string | null) => (t && t.includes('도박') ? ['도박'] : []),
  } as unknown as ForbiddenWordMatcher;

  return new AutoOrderService(
    new AutoOrderExcelParser(),
    new AutoOrderStructureValidator(),
    new AutoOrderProductMapper(productRepo),
    new AutoOrderPreValidator(matcher),
    new AutoOrderPayloadBuilder(),
    fileService,
    userRepo,
    rangeRepo,
  );
}

const admin: ILoginUserInfo = { id: 1, email: 'a@a.com', authority: 'SUPER_ADMIN' as any };
const receipt = (filePath: string): OrderReceiptEntity => ({ id: 100, userId: 10, filePath }) as OrderReceiptEntity;

describe('AutoOrderService (DRY_RUN 미리보기)', () => {
  it('일반+SSG 혼합 → 주문 2건, 검산 일치', async () => {
    const buf = await buildFilledBuffer([
      { b: '010-1111-1111', code: 'GEN-1' },
      { b: '010-2222-2222', code: 'GEN-1' },
      { b: '010-3333-3333', code: 'SSG-1' },
    ]);
    const svc = makeService({ 'u://a.xlsx': buf });

    const result = await svc.run(receipt('u://a.xlsx'), admin, AutoOrderRunMode.DRY_RUN);

    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.status).toBe('VALID');
    expect(file.orders).toHaveLength(2); // GENERAL 1 + SSG 1
    expect(file.orders.every((o) => o.orderId === null)).toBe(true); // DRY_RUN

    const general = file.orders.find((o) => o.type === 'GENERAL')!;
    expect(general.deliveryCount).toBe(2);
    const ssg = file.orders.find((o) => o.type === 'SSG')!;
    expect(ssg.deliveryCount).toBe(1);

    expect(file.reconciliation.expectedDeliveryCount).toBe(3);
    expect(file.reconciliation.builtDeliveryCount).toBe(3);
    expect(file.reconciliation.matched).toBe(true);
  });

  it('미매핑/제외/ROW차단 → 검산 버킷 정확', async () => {
    const buf = await buildFilledBuffer([
      { b: '010-1111-1111', code: 'GEN-1' }, // built
      { b: '010-2222-2222', code: '없음' }, // unmapped
      { b: '010-3333-3333', code: 'GEN-1', valid: false }, // excluded
      { b: '010-4444-4444', code: 'GEN-1', rep1: '도박' }, // ROW blocked
    ]);
    const svc = makeService({ 'u://b.xlsx': buf });

    const file = (await svc.run(receipt('u://b.xlsx'), admin, AutoOrderRunMode.DRY_RUN)).files[0];

    expect(file.reconciliation.inputRowCount).toBe(4);
    expect(file.reconciliation.unmappedCount).toBe(1);
    expect(file.reconciliation.excludedCount).toBe(1);
    expect(file.reconciliation.builtDeliveryCount).toBe(1);
    expect(file.reconciliation.blockedDeliveryCount).toBe(1); // 4-1-1-1
    expect(file.reconciliation.matched).toBe(true);
    expect(file.blockedRows.some((b) => b.level === 'ROW')).toBe(true);
    expect(file.fileBlocked).toBe(false);
  });

  it('제목 금칙어 → FILE 차단(주문 0건, built=0)', async () => {
    const wb = await buildFilledBuffer([{ b: '010-1111-1111', code: 'GEN-1' }]);
    // 제목을 금칙어로 다시 씀
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(wb);
    workbook.getWorksheet('1.신청정보')!.getCell('C20').value = '도박 광고';
    const buf = (await workbook.xlsx.writeBuffer()) as Buffer;

    const svc = makeService({ 'u://c.xlsx': buf });
    const file = (await svc.run(receipt('u://c.xlsx'), admin, AutoOrderRunMode.DRY_RUN)).files[0];

    expect(file.fileBlocked).toBe(true);
    expect(file.orders).toHaveLength(0);
    expect(file.reconciliation.builtDeliveryCount).toBe(0);
    expect(file.blocked.some((b) => b.field === 'TITLE')).toBe(true);
  });

  it('양식버전 불일치 → INVALID_FORMAT', async () => {
    const buf = await buildFilledBuffer([{ b: '010-1111-1111', code: 'GEN-1' }], 'v3.9');
    const svc = makeService({ 'u://d.xlsx': buf });
    const file = (await svc.run(receipt('u://d.xlsx'), admin, AutoOrderRunMode.DRY_RUN)).files[0];
    expect(file.status).toBe('INVALID_FORMAT');
    expect(file.orders).toHaveLength(0);
  });

  it('첨부 여러 개 → files 배열로 각각 처리', async () => {
    const a = await buildFilledBuffer([{ b: '010-1111-1111', code: 'GEN-1' }]);
    const b = await buildFilledBuffer([{ b: '010-2222-2222', code: 'SSG-1' }]);
    const svc = makeService({ 'u://a.xlsx': a, 'u://b.xlsx': b });

    const result = await svc.run(receipt('u://a.xlsx,u://b.xlsx'), admin, AutoOrderRunMode.DRY_RUN);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].fileIndex).toBe(0);
    expect(result.files[1].fileIndex).toBe(1);
  });
});
