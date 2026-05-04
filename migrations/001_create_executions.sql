CREATE TABLE executions (
  execution_id UNIQUEIDENTIFIER PRIMARY KEY,
  story_id VARCHAR(255) NOT NULL,
  issue_id VARCHAR(255) NULL,
  epic_id VARCHAR(255) NULL,
  project_key VARCHAR(50) NULL,
  status VARCHAR(50) NOT NULL,
  current_state VARCHAR(50) NOT NULL,
  started_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
  completed_at DATETIME2 NULL,
  failure_reason NVARCHAR(MAX) NULL
);

