import { Controller, Get, Inject } from '@nestjs/common';
import { IErpExtern } from './erp/interface/erp.extern';

@Controller()
export class AppController {
  constructor(
    @Inject('IErpExtern')
    private erp: IErpExtern,
  ) {}

  @Get('erp-test')
  erpTest() {
    this.erp.issue({
      SaleOrderList: [
        {
          BulkDatas: {
            U_MEMO1: '김고객',
            CUST_DES: '큰고객사',
            WH_CD: '02',
            U_MEMO4: '큰이벤트',
            TIME_DATE: '20250324',
            ADD_TXT_10_T: '이벤트상세',
            U_TXT1: '특이사항',
            PROD_CD: '00002',
            REMARKS: '큰브랜드명',
            P_REMARKS1: '큰공급처',
            PROD_DES: '큰품목명',
            QTY: '10',
            PRICE: '10000',
            SUPPLY_AMT: '100000',
            P_REMARKS2: '김담당',
          },
        },
        {
          BulkDatas: {
            U_MEMO1: '이고객',
            CUST_DES: '작은고객사',
            WH_CD: '02',
            U_MEMO4: '작은이벤트',
            TIME_DATE: '20250324',
            ADD_TXT_10_T: '이벤트상세',
            U_TXT1: '특이사항',
            PROD_CD: '00002',
            REMARKS: '작은브랜드명',
            P_REMARKS1: '작은공급처',
            PROD_DES: '작은품목명',
            QTY: '10',
            PRICE: '10000',
            SUPPLY_AMT: '100000',
            P_REMARKS2: '이담당',
          },
        },
      ],
    });
    return '';
  }

  @Get('/health-check')
  healthCheck(): string {
    return 'health-check';
  }
}
