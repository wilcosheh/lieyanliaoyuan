import { GameScreen } from "@web/battle/game-screen";

export default async function PreparePage(
  { params }: { params: Promise<{ battleId: string }> },
) {
  return <GameScreen battleId={(await params).battleId} mode="prepare" />;
}
