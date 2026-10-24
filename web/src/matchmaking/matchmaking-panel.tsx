"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Flame, Mic, Search, Swords, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { webApi } from "@web/api/client";

export function MatchmakingPanel() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [ticketId, setTicketId] = useState<string | null>(null);
  const session = useQuery({
    queryKey: ["session"],
    queryFn: webApi.createSession,
    staleTime: Infinity,
  });
  const ticket = useQuery({
    queryKey: ["ticket", ticketId],
    queryFn: () => webApi.getMatch(ticketId!),
    enabled: Boolean(ticketId),
    refetchInterval: 600,
  });
  const join = useMutation({
    mutationFn: () => webApi.joinMatch(nickname),
    onSuccess: (result) => setTicketId(result.id),
  });
  const cancel = useMutation({
    mutationFn: () => webApi.cancelMatch(ticketId!),
    onSuccess: () => setTicketId(null),
  });

  useEffect(() => {
    if (ticket.data?.status === "MATCHED" && ticket.data.battleId) {
      router.replace(`/prepare/${ticket.data.battleId}`);
    }
  }, [router, ticket.data]);

  const waiting = Boolean(ticketId);
  return (
    <main className="entry-shell">
      <section className="brand-panel" aria-label="烈焰燎原">
        <div className="brand-mark">
          <Flame aria-hidden="true" />
        </div>
        <p className="eyebrow">VOICE DUEL / 1V1</p>
        <h1>烈焰燎原</h1>
        <p className="brand-line">声焰交锋，一决胜负。</p>
        <div className="duel-emblem" aria-hidden="true">
          <Swords />
        </div>
      </section>
      <section className="match-panel">
        <div className="match-copy">
          <span className="status-dot" />
          <span>{waiting ? "正在搜寻对手" : "竞技场开放"}</span>
        </div>
        {!waiting
          ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                join.mutate();
              }}
              className="match-form"
            >
              <label htmlFor="nickname">你的称号</label>
              <input
                id="nickname"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                maxLength={20}
                placeholder="输入 1-20 个字符"
                autoComplete="nickname"
              />
              <button
                className="primary-button"
                disabled={!nickname.trim() || !session.isSuccess ||
                  join.isPending}
              >
                <Search aria-hidden="true" />
                {join.isPending ? "正在加入" : "快速匹配"}
              </button>
            </form>
          )
          : (
            <div className="searching">
              <div className="radar" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p>正在寻找旗鼓相当的对手</p>
              <button
                className="quiet-button"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                <X aria-hidden="true" />取消匹配
              </button>
            </div>
          )}
        <div className="device-check">
          <Mic aria-hidden="true" />
          <span>麦克风待命</span>
        </div>
        {(join.error || ticket.error) && (
          <p className="error-banner">匹配服务暂时不可用，请稍后重试。</p>
        )}
      </section>
    </main>
  );
}
