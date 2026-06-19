import { ApiAppEntity } from '../../entity/api.app.entity';
import { ApiCredentialEntity } from '../../entity/api.credential.entity';

export interface ApiRequestContext {
  apiApp: ApiAppEntity;
  apiCredential: ApiCredentialEntity;
  billingUserId: number;
  externalCustomerId?: string | null;
}
