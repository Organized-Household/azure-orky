IF NOT EXISTS (
  SELECT * FROM sysobjects WHERE name='instruction_packets' AND xtype='U'
)
BEGIN
  CREATE TABLE instruction_packets (
    packetId        NVARCHAR(36)    NOT NULL PRIMARY KEY,
    executionId     NVARCHAR(36)    NOT NULL,
    storyId         NVARCHAR(100)   NOT NULL,
    targetRepository NVARCHAR(255)  NOT NULL,
    baseBranch      NVARCHAR(255)   NOT NULL,
    branchNameHint  NVARCHAR(255)   NOT NULL,
    fileOperations  NVARCHAR(MAX)   NOT NULL,  -- JSON
    validationCommands NVARCHAR(MAX) NOT NULL, -- JSON
    receivedAt      DATETIME2       NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT FK_InstructionPackets_Executions
      FOREIGN KEY (executionId) REFERENCES executions(executionId)
  );
END
