export type MatchTicketRecord = {
  id: string;
  playerId: string;
  status: "WAITING" | "MATCHED" | "CANCELLED";
  battleId: string | null;
};

export type MatchJoinResult = {
  ticket: MatchTicketRecord;
  matchedPlayerIds: string[] | null;
};

export type VoiceCommandRecord = {
  battleId: string;
  commandId: string;
  playerId: string;
  roundNo: number;
  status: "RECEIVED" | "RECOGNIZED" | "SUBMITTED" | "FAILED";
  transcript: string | null;
  perfection: number | null;
  confidenceSource: "provider" | "fallback" | null;
  errorCode: string | null;
};

export interface WebLobbyRepository {
  joinMatch(playerId: string, nickname: string): Promise<MatchJoinResult>;
  getTicket(
    ticketId: string,
    playerId: string,
  ): Promise<MatchTicketRecord | null>;
  cancelTicket(ticketId: string, playerId: string): Promise<boolean>;
  isBattleMember(battleId: string, playerId: string): Promise<boolean>;
  getBattleNicknames(battleId: string): Promise<Record<string, string>>;
  claimVoiceCommand(
    input: Omit<
      VoiceCommandRecord,
      "status" | "transcript" | "perfection" | "confidenceSource" | "errorCode"
    >,
  ): Promise<{ claimed: boolean; record: VoiceCommandRecord }>;
  updateVoiceCommand(record: VoiceCommandRecord): Promise<void>;
  getVoiceCommand(
    battleId: string,
    commandId: string,
  ): Promise<VoiceCommandRecord | null>;
}

/** 单进程开发仓库；生产环境的多实例共享状态由 Supabase 实现。 */
export class InMemoryWebLobbyRepository implements WebLobbyRepository {
  private readonly tickets = new Map<string, MatchTicketRecord>();
  private readonly nicknames = new Map<string, string>();
  private readonly members = new Map<string, Set<string>>();
  private readonly commands = new Map<string, VoiceCommandRecord>();

  joinMatch(playerId: string, nickname: string): Promise<MatchJoinResult> {
    this.nicknames.set(playerId, nickname.trim().slice(0, 20) || "无名挑战者");
    const existing = [...this.tickets.values()].find((ticket) =>
      ticket.playerId === playerId && ticket.status !== "CANCELLED"
    );
    if (existing) {
      return Promise.resolve({
        ticket: structuredClone(existing),
        matchedPlayerIds: null,
      });
    }

    const id = crypto.randomUUID();
    const opponent = [...this.tickets.values()].find((ticket) =>
      ticket.status === "WAITING" && ticket.playerId !== playerId
    );
    if (!opponent) {
      const ticket: MatchTicketRecord = {
        id,
        playerId,
        status: "WAITING",
        battleId: null,
      };
      this.tickets.set(id, ticket);
      return Promise.resolve({
        ticket: structuredClone(ticket),
        matchedPlayerIds: null,
      });
    }

    const battleId = crypto.randomUUID();
    opponent.status = "MATCHED";
    opponent.battleId = battleId;
    const ticket: MatchTicketRecord = {
      id,
      playerId,
      status: "MATCHED",
      battleId,
    };
    this.tickets.set(id, ticket);
    this.members.set(battleId, new Set([opponent.playerId, playerId]));
    return Promise.resolve({
      ticket: structuredClone(ticket),
      matchedPlayerIds: [opponent.playerId, playerId],
    });
  }

  getTicket(
    ticketId: string,
    playerId: string,
  ): Promise<MatchTicketRecord | null> {
    const record = this.tickets.get(ticketId);
    return Promise.resolve(
      record?.playerId === playerId ? structuredClone(record) : null,
    );
  }

  cancelTicket(ticketId: string, playerId: string): Promise<boolean> {
    const record = this.tickets.get(ticketId);
    if (
      !record || record.playerId !== playerId || record.status !== "WAITING"
    ) return Promise.resolve(false);
    record.status = "CANCELLED";
    return Promise.resolve(true);
  }

  isBattleMember(battleId: string, playerId: string): Promise<boolean> {
    return Promise.resolve(this.members.get(battleId)?.has(playerId) ?? false);
  }

  getBattleNicknames(battleId: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const playerId of this.members.get(battleId) ?? []) {
      result[playerId] = this.nicknames.get(playerId) ?? "挑战者";
    }
    return Promise.resolve(result);
  }

  claimVoiceCommand(
    input: Omit<
      VoiceCommandRecord,
      "status" | "transcript" | "perfection" | "confidenceSource" | "errorCode"
    >,
  ): Promise<{ claimed: boolean; record: VoiceCommandRecord }> {
    const key = `${input.battleId}:${input.commandId}`;
    const existing = this.commands.get(key);
    if (existing) {
      return Promise.resolve({
        claimed: false,
        record: structuredClone(existing),
      });
    }
    const record: VoiceCommandRecord = {
      ...input,
      status: "RECEIVED",
      transcript: null,
      perfection: null,
      confidenceSource: null,
      errorCode: null,
    };
    this.commands.set(key, record);
    return Promise.resolve({ claimed: true, record: structuredClone(record) });
  }

  updateVoiceCommand(record: VoiceCommandRecord): Promise<void> {
    this.commands.set(
      `${record.battleId}:${record.commandId}`,
      structuredClone(record),
    );
    return Promise.resolve();
  }

  getVoiceCommand(
    battleId: string,
    commandId: string,
  ): Promise<VoiceCommandRecord | null> {
    const record = this.commands.get(`${battleId}:${commandId}`);
    return Promise.resolve(record ? structuredClone(record) : null);
  }
}
