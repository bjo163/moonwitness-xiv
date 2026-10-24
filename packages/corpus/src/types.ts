export interface IngestionRecipe {
  format: 'moonwitness-ingestion-recipe/v1';
  recipeId: string;
  source: {
    path: string;
    sha256: string;
  };
  parser: 'json-record-array/v1';
}

export interface IngestionRequest {
  rootDirectory: string;
  recipePath: string;
  outputPath: string;
  dryRun?: boolean;
  release?: {
    datasetId: string;
    version: string;
    ontologyVersion: string;
    corpusVersion: string;
    createdAt?: string;
  };
}

export interface IngestionReport {
  format: 'moonwitness-ingestion-report/v1';
  recipeId: string;
  recipeSha256: string;
  parser: IngestionRecipe['parser'];
  source: {
    path: string;
    sha256: string;
    bytes: number;
  };
  records: number;
  snapshotSha256: string;
  outputPath: string;
  dryRun: boolean;
  releaseId?: string;
}
