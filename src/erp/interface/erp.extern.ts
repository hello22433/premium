import { ErpRequestIn } from './erp.request';
import { ErpProductListRequest, ErpProductDetailRequest } from './erp.product.request';
import { ErpProductListResponse } from './erp.product.response';

export interface IErpExtern {
  issue(obj: ErpRequestIn): Promise<void>;
  getProductsList(req: ErpProductListRequest): Promise<ErpProductListResponse>;
  getProduct(req: ErpProductDetailRequest): Promise<ErpProductListResponse>;
}
