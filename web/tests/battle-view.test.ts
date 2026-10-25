import { describe, expect, it } from "vitest";
import { toWebBattleView } from "../../src/adapter/http/battle_view.ts";
import { BattleController } from "../../src/engine/rules/controller.ts";

function startedController() {
  const controller = new BattleController("battle", ["a", "b"]);
  controller.preparePlayer("a", "swordsman");
  controller.preparePlayer("b", "guardian");
  controller.setReady("a");
  controller.setReady("b");
  controller.startBattle();
  return controller;
}

describe("toWebBattleView", () => {
  it("按玩家视角生成昵称、技能和增量事件", () => {
    const controller = startedController();
    const view = toWebBattleView({
      state: controller.getState(),
      version: 5,
      playerId: "a",
      nicknames: { a: "阿焰", b: "铁壁" },
      afterSequence: 2,
    });
    expect(view.self.nickname).toBe("阿焰");
    expect(view.opponent.nickname).toBe("铁壁");
    expect(view.skills).toHaveLength(7);
    expect(view.events.every((event) => event.sequence > 2)).toBe(true);
    expect(view).not.toHaveProperty("processedCommands");
  });

  it("基础技能使用后在下一回合显示为不可用", () => {
    const controller = startedController();
    controller.submitAction({
      playerId: "a",
      commandId: "one",
      roundNo: 1,
      skillText: "破风斩",
    });
    controller.advance();
    controller.advance();
    const view = toWebBattleView({
      state: controller.getState(),
      version: 8,
      playerId: "a",
    });
    const basic = view.skills.find((skill) => skill.id === "swordsman_basic")!;
    expect(basic.available).toBe(false);
    expect(basic.unavailableReason).toContain("不能连续");
  });

  it("拒绝为非对局玩家生成视图", () => {
    const controller = startedController();
    expect(() =>
      toWebBattleView({
        state: controller.getState(),
        version: 1,
        playerId: "x",
      })
    ).toThrow("PLAYER_NOT_IN_BATTLE");
  });
});
