import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../dbClient';
import { ReviewVerdict } from '../../integrations/review/packetReviewer';

export interface NegotiationRound {
  negotiationId: string;
  executionId: string;
  storyId: string;
  roundNumber: number;
  verdict: ReviewVerdict;
  issues: string[];
  revisedPacketId: string | null;
  createdAt: Date;
}

export class PacketNegotiationRepository {
  async saveRound(
    executionId: string,
    storyId: string,
    roundNumber: number,
    verdict: ReviewVerdict,
    issues: string[],
    revisedPacketId: string | null,
  ): Promise<NegotiationRound> {
    const pool = getPool();
    const negotiationId = uuidv4();

    await pool.query(
      `INSERT INTO packet_negotiations (
        negotiation_id,
        execution_id,
        story_id,
        round_number,
        verdict,
        issues,
        revised_packet_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        negotiationId,
        executionId,
        storyId,
        roundNumber,
        verdict,
        JSON.stringify(issues),
        revisedPacketId,
      ],
    );

    return {
      negotiationId,
      executionId,
      storyId,
      roundNumber,
      verdict,
      issues,
      revisedPacketId,
      createdAt: new Date(),
    };
  }

  async getRoundsByExecutionId(executionId: string): Promise<NegotiationRound[]> {
    const pool = getPool();

    const result = await pool.query<{
      negotiation_id: string;
      execution_id: string;
      story_id: string;
      round_number: number;
      verdict: ReviewVerdict;
      issues: string;
      revised_packet_id: string | null;
      created_at: Date;
    }>(
      `SELECT
        negotiation_id,
        execution_id,
        story_id,
        round_number,
        verdict,
        issues,
        revised_packet_id,
        created_at
       FROM packet_negotiations
       WHERE execution_id = $1
       ORDER BY round_number ASC`,
      [executionId],
    );

    return result.rows.map((row) => ({
      negotiationId: row.negotiation_id,
      executionId: row.execution_id,
      storyId: row.story_id,
      roundNumber: row.round_number,
      verdict: row.verdict,
      issues: JSON.parse(row.issues) as string[],
      revisedPacketId: row.revised_packet_id,
      createdAt: row.created_at,
    }));
  }
}
