import { ErpRequestIn } from './erp.request';

export interface IErpExtern {
  issue(obj: ErpRequestIn): Promise<void>;
}
