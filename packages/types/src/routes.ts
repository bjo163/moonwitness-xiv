export interface ModelParam {
  model: string;
}

export interface ModelIdParam extends ModelParam {
  id: string;
}

export interface ModelActionParam extends ModelIdParam {
  method: string;
}

export interface SearchQueryParams {
  domain?: string;
  fields?: string;
  limit?: string;
  offset?: string;
  /** ID cursor for stable keyset pagination; combine only with ascending ID order. */
  cursor?: string;
  order?: string;
  with?: string;
  count?: string;
}

export interface GroupCountQueryParams {
  domain?: string;
  group_by?: string;
  limit?: string;
  offset?: string;
}

export interface DeleteQueryParams {
  hard?: string;
}

export interface ActionRequestBody {
  args?: JsonValue[];
  kwargs?: Record<string, JsonValue>;
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  database: 'connected' | 'disconnected';
  attachmentStorage?: 'connected' | 'disconnected';
  registeredModels: string[];
}

export interface RootInfoResponse {
  name: string;
  version: string;
  docs: string;
  modelsEndpoint: string;
  healthEndpoint: string;
  jsonrpcEndpoint: string;
}

export interface ModelListResponseItem {
  model: string;
  table: string;
  menu: {
    label?: string;
    group: string;
    sequence: number;
    developmentOnly: boolean;
  };
}

export interface ModelListResponse {
  success: boolean;
  models: ModelListResponseItem[];
}
import type { JsonValue } from './domain.js';
