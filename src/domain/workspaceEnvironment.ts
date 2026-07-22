/**
 * Placeholder environment-isolation model. Not populated or acted on in the MVP,
 * but defined so the persistence format is forward-compatible.
 */
export interface WorkspaceEnvironment {
  applicationPort?: number;
  databaseName?: string;
  databaseEnvironment?: string;
  queueEnvironment?: string;
}
