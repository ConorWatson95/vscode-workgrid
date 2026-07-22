/**
 * Placeholder pipeline model. Defined so persisted tasks can round-trip
 * pipeline state, but no workflow engine is implemented in the MVP.
 */
export type TaskStageStatus =
  | "pending"
  | "active"
  | "passed"
  | "failed"
  | "skipped";

export interface TaskStage {
  name: string;
  status: TaskStageStatus;
}

export interface TaskPipeline {
  stages: TaskStage[];
  currentStage?: string;
}
