IF NOT EXISTS (
  SELECT * FROM sysobjects WHERE name='instruction_packets' AND xtype='U'
)
BEGIN
  CREATE TABLE instruction_packets (
    packet_id           NVARCHAR(36)        NOT NULL PRIMARY KEY,
    execution_id        UNIQUEIDENTIFIER    NOT NULL,
    story_id            NVARCHAR(100)       NOT NULL,
    target_repository   NVARCHAR(255)       NOT NULL,
    base_branch         NVARCHAR(255)       NOT NULL,
    branch_name_hint    NVARCHAR(255)       NOT NULL,
    file_operations     NVARCHAR(MAX)       NOT NULL,  -- JSON
    validation_commands NVARCHAR(MAX)       NOT NULL,  -- JSON
    received_at         DATETIME2           NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_InstructionPackets_Executions
      FOREIGN KEY (execution_id) REFERENCES executions(execution_id)
  );
END
