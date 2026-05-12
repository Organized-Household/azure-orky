export interface BatchExecution {
  batch_execution_id: string;
  epic_id: string;
  project_key: string;
  batch_status: string;
  story_ids: string[];
  packet_plan_json: object | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  failure_reason: string | null;
}

export type NewBatchExecution = Omit<
  BatchExecution,
  'batch_execution_id' | 'created_at' | 'updated_at' | 'completed_at' | 'failure_reason'
>;
