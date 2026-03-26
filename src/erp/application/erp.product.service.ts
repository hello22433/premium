import { Inject, Injectable } from '@nestjs/common';
import { IErpExtern } from '../interface/erp.extern';
import { ErpProductListRequest, ErpProductDetailRequest } from '../interface/erp.product.request';
import { ErpProductListResponse } from '../interface/erp.product.response';

@Injectable()
export class ErpProductService {
  constructor(
    @Inject('IErpExtern')
    private readonly erpExtern: IErpExtern,
  ) {}

  async getProductsList(req: ErpProductListRequest): Promise<ErpProductListResponse> {
    return this.erpExtern.getProductsList(req);
  }

  async getProduct(req: ErpProductDetailRequest): Promise<ErpProductListResponse> {
    return this.erpExtern.getProduct(req);
  }
}
