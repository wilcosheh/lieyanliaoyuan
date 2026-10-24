import { GameScreen } from "@web/battle/game-screen";

export default async function BattlePage(
  { params }: { params: Promise<{ battleId: string }> },
) {
  return <GameScreen battleId={(await params).battleId} mode="battle" />;
}
