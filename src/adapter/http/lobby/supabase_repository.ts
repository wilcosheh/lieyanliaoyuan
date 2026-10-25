import type {
  MatchJoinResult,
  MatchTicketRecord,
  VoiceCommandRecord,
  WebLobbyRepository,
} from "./repository.ts";

type MatchRow = {
  ticket_id: string;
  player_id: string;
  status: MatchTicketRecord["status"];
  battle_id: string | null;
};

type VoiceRow = {
  battle_id: string;
  command_id: string;
  player_id: string;
  round_no: number;
  status: VoiceCommandRecord["status"];
  transcript: string | null;
  perfection: number | null;
  confidence_source: VoiceCommandRecord["confidenceSource"];
  error_code: string | null;
};

/** Web 大厅、成员关系和语音命令幂等记录的 Supabase 实现。 */
export class SupabaseWebLobbyRepository implements WebLobbyRepository {
  private readonly url: string;

  constructor(
    url: string,
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {
    this.url = url.replace(/\/$/, "");
  }

  async joinMatch(
    playerId: string,
    nickname: string,
  ): Promise<MatchJoinResult> {
    const payload = await this.rpc<{
      ticket: MatchRow;
      matched_player_ids: string[] | null;
    }>("web_join_match", { p_player_id: playerId, p_nickname: nickname });
    return {
      ticket: this.ticket(payload.ticket),
      matchedPlayerIds: payload.matched_player_ids,
    };
  }

  async getTicket(
    ticketId: string,
    playerId: string,
  ): Promise<MatchTicketRecord | null> {
    const rows = await this.rest<MatchRow[]>(
      `web_match_ticket?ticket_id=eq.${
        encodeURIComponent(ticketId)
      }&player_id=eq.${encodeURIComponent(playerId)}` +
        "&select=ticket_id,player_id,status,battle_id",
    );
    return rows[0] ? this.ticket(rows[0]) : null;
  }

  async cancelTicket(ticketId: string, playerId: string): Promise<boolean> {
    const rows = await this.rest<MatchRow[]>(
      `web_match_ticket?ticket_id=eq.${
        encodeURIComponent(ticketId)
      }&player_id=eq.${encodeURIComponent(playerId)}&status=eq.WAITING`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "CANCELLED" }),
      },
    );
    return rows.length === 1;
  }

  async isBattleMember(battleId: string, playerId: string): Promise<boolean> {
    const rows = await this.rest<Array<{ battle_id: string }>>(
      `web_battle_member?battle_id=eq.${
        encodeURIComponent(battleId)
      }&player_id=eq.${encodeURIComponent(playerId)}&select=battle_id`,
    );
    return rows.length === 1;
  }

  async getBattleNicknames(battleId: string): Promise<Record<string, string>> {
    const rows = await this.rest<
      Array<{ player_id: string; nickname: string }>
    >(
      `web_battle_member?battle_id=eq.${
        encodeURIComponent(battleId)
      }&select=player_id,nickname`,
    );
    return Object.fromEntries(rows.map((row) => [row.player_id, row.nickname]));
  }

  async claimVoiceCommand(
    input: Omit<
      VoiceCommandRecord,
      "status" | "transcript" | "perfection" | "confidenceSource" | "errorCode"
    >,
  ) {
    const claimed = await this.rpc<boolean>("web_voice_command_claim", {
      p_battle_id: input.battleId,
      p_command_id: input.commandId,
      p_player_id: input.playerId,
      p_round_no: input.roundNo,
    });
    const record = await this.getVoiceCommand(input.battleId, input.commandId);
    if (!record) throw new Error("claimed voice command was not persisted");
    return { claimed, record };
  }

  async updateVoiceCommand(record: VoiceCommandRecord): Promise<void> {
    await this.rest<unknown>(
      `web_voice_command?battle_id=eq.${
        encodeURIComponent(record.battleId)
      }&command_id=eq.${encodeURIComponent(record.commandId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: record.status,
          transcript: record.transcript,
          perfection: record.perfection,
          confidence_source: record.confidenceSource,
          error_code: record.errorCode,
          updated_at: new Date().toISOString(),
        }),
      },
    );
  }

  async getVoiceCommand(
    battleId: string,
    commandId: string,
  ): Promise<VoiceCommandRecord | null> {
    const rows = await this.rest<VoiceRow[]>(
      `web_voice_command?battle_id=eq.${
        encodeURIComponent(battleId)
      }&command_id=eq.${encodeURIComponent(commandId)}` +
        "&select=battle_id,command_id,player_id,round_no,status,transcript,perfection,confidence_source,error_code",
    );
    const row = rows[0];
    return row
      ? {
        battleId: row.battle_id,
        commandId: row.command_id,
        playerId: row.player_id,
        roundNo: Number(row.round_no),
        status: row.status,
        transcript: row.transcript,
        perfection: row.perfection === null ? null : Number(row.perfection),
        confidenceSource: row.confidence_source,
        errorCode: row.error_code,
      }
      : null;
  }

  private ticket(row: MatchRow): MatchTicketRecord {
    return {
      id: row.ticket_id,
      playerId: row.player_id,
      status: row.status,
      battleId: row.battle_id,
    };
  }

  private async rpc<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    return await this.rest<T>(`rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(args),
    });
  }

  private async rest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(`${this.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`web repository ${response.status}: ${body}`);
    }
    return (body ? JSON.parse(body) : undefined) as T;
  }
}
