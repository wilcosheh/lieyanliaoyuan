# 烈焰燎原

两人用灵矽设备念咒对战。燎原是裁判：房间、吟唱、打断、血量和结算都在服务端。灵矽只负责听和说，通过对接本服务的云端
MCP 进出每一拍。

没有网页大屏。两边听到的战报、咒语音效、对方原声和胜负，都从各自设备的喇叭出来。

## 本地先跑通

```bash
deno task test
deno task sim
deno task dev
```

`sim` 会拉起两个假设备，走完整条 MCP
链路：开房、准备、开战、火矢命中、下一拍播放对方原声、烈焰燎原被火矢打断、认输结算、拉取
wav。

Web 游戏本地启动：

```bash
cd web
npm install
npm run dev
```

页面默认位于 `http://localhost:3000`。未配置 Supabase 时使用单进程内存仓库；生产环境需配置
`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`WEB_SESSION_SECRET` 和七牛语音环境变量。

服务默认听 `8787`。灵矽里填写的 SSE 地址是：

```text
http://<公网主机>:8787/mcp
```

本机没有公网地址时，用 Supabase 的函数地址。

## 一局怎么走

1. 两边各自说名字，一边说「开房间」，另一边说四位房间号，然后都说「准备」。
2. 双方准备齐，两边同时听到开战，角色切成战场播报。
3. 播报说完一句就调用 `wait_event`
   挂起。对手的下一记咒语、打断和结算，都从这个挂起的调用里返回。
4. 玩家开口时调用 `cast`，`utterance`
   是原话。念错、法力不够、冷却中都会短时间禁言。
5. 长咒吟唱期间，对手可以念短咒打断。离结算不到 300 毫秒时，两边同时生效。
6. 有人倒下、时间到或有人认输，两边分别听到赢或输，并切回复盘。说「复盘」再听过程。

咒语：

| 咒语             | 法力 | 吟唱   | 冷却 | 效果                          |
| ---------------- | ---- | ------ | ---- | ----------------------------- |
| 火矢             | 2    | 瞬发   | 3 秒 | 4 伤                          |
| 水幕             | 3    | 瞬发   | 8 秒 | 6 秒内挡下一次伤害，最多 8 点 |
| 寒霜止步         | 4    | 4.5 秒 | 8 秒 | 3 伤，禁言 3 秒               |
| 烈焰燎原         | 5    | 6 秒   | 5 秒 | 12 伤                         |
| 九天神火焚尽八荒 | 9    | 8 秒   | 无   | 25 伤                         |

开局 30 血、4 法力，每秒回复 1 点，上限 10。整局 120 秒。四字咒允许错 1
个音节，八字咒允许错 2 个，两字咒必须念准。错音按七成结算。

吟唱故意留得比较长。对手要先听见「正在吟唱」，自己再说出短咒，中间还有一轮语音识别。如果真机上仍然打断不了，把
`src/game/logic.ts` 里的 `channelMs` 再加长。

## 音效和对方原声

命中、张开水幕、被打断、胜利和落败，都会在工具结果里带 `linx_play`。音频地址是：

```text
<SSE 根地址>/sfx/huoshi.wav
```

服务自己合成这些短 wav，不依赖对象存储。

对方原始念咒不会堵在结算那一拍。有两种来法：

- `cast` 如果带了 `audio_url`，下一则战报里直接播放。
- 配置了 `LINX_API_KEY` 后，服务用请求头里的 `X-Linx-Agent-Id` 和
  `X-Linx-Session-Id` 去拉聊天记录，签出一小时有效的地址，在下一次 `wait_event`
  里播放。结算本身不等这条录音。

## 灵矽控制台

智能体建议：

- 模型用 deepseek-v4-flash，温度 0，回答尽量短。
- 关闭记忆、开场白和其他内置工具，只留这个 MCP。
- 空闲超时拉到 300 秒。拾音用手动或自动都可以，先用手动把每句边界定清楚。

MCP 的 SSE URL 填上面的 `/mcp`。平台会发 `GET /mcp`，再把 JSON-RPC 打到
`/mcp/message`。工具结果从这条 SSE 上按请求 id 回去，所以 `ready` 和
`wait_event` 可以先挂住，等对手动作后再返回。

身份只认请求头
`X-Linx-Device-Id`，不让模型自己报设备号。两个设备可以绑同一个智能体。

初始提示词用大厅主持。开战和结束时，服务会用 `change_role`
换成战场播报和复盘。提示词全文在 `src/game/logic.ts` 的 `LOBBY_PROMPT`。

## 部署到 Supabase

边缘函数单次响应大约 150
秒会被网关掐断，长连接不能当整局的唯一通道。所以房间状态在 Postgres，SSE
断了，模型按提示词再调一次 `wait_event`，漏掉的战报还在。

这台开发机没有 Supabase
登录态，云端项目还没推上去。代码和迁移已经按这个部署方式写好：

```bash
supabase login
export SUPABASE_PROJECT_REF=<project-ref>
export LINX_API_KEY=<灵矽控制台的 key>
sh scripts/deploy_supabase.sh
```

脚本会推迁移、写入 `PUBLIC_BASE_URL` 和灵矽密钥，并关闭 JWT 校验。灵矽不会带
Supabase 的用户令牌。部署完成后，SSE URL 是：

```text
https://<project-ref>.supabase.co/functions/v1/mcp
```

如果网关仍然要求 `apikey`，把项目的 anon key 填进灵矽 MCP 的 Header，不要填
service role。

## 目录

- `src/game/logic.ts`：咒语、命中、打断、结算
- `src/battle/index.ts`：新对局内核的公开入口
- `src/battle/controller.ts`：唯一规则控制层，负责校验和阶段推进
- `src/battle/state.ts`：拥有全部运行状态的内部状态机，不承载规则判断
- `src/battle/skills.ts`：角色、技能和效果配置
- `src/battle/session.ts`：按 `battleId` 加载、串行执行并保存对局请求
- `src/battle/repository.ts`：带版本号和 CAS 的对局仓库接口及内存实现
- `src/battle/supabase_repository.ts`：跨进程共享的 Supabase/Postgres 仓库实现
- `src/web/battle_application.ts`：Web 对局编排、权限校验、语音命令幂等和自动推进
- `src/web/lobby/`：匹配、对局成员与语音命令仓库
- `src/web/speech/`：七牛 ASR/TTS 适配接口
- `web/`：Next.js Web BFF、游戏界面、录音与前端测试
- `docs/web-architecture-design.md`：Next.js Web 接入层、游戏界面和七牛语音方案
- `src/mcp/handler.ts`：MCP SSE 和工具调用
- `src/mcp/store.ts`：单进程内存房，本地和 `sim` 用它
- `src/mcp/supabase_store.ts`：同一套规则落到 Postgres
- `scripts/sim_match.ts`：两个假设备走完一局

## 新对局内核

`src/battle`
只实现对局状态和规则，不处理客户端协议、提示文案或消息推送。请求处理代码应从
`src/battle/index.ts` 使用 `BattleSessionService`，不要为每个请求自行创建
`BattleController`，也不要直接调用 `state.ts` 的内部状态写方法。

`BattleStateMachine`
内部持有对局状态、回合状态、角色状态、状态效果、技能使用记录、事件序列和命令幂等记录，并提供无规则判断的增删改查。`BattleController`
只持有状态机实例和不可变规则配置，所有合法性判断完成后再调用状态机变更数据。外部获得的都是深拷贝快照。

```ts
import {
  BattleSessionService,
  InMemoryBattleRepository,
} from "./src/battle/index.ts";

const repository = new InMemoryBattleRepository();
const service = new BattleSessionService(repository);
await service.createBattle({
  battleId: "battle-1",
  playerIds: ["player-a", "player-b"],
});
await service.preparePlayer("battle-1", "player-a", "swordsman");
await service.preparePlayer("battle-1", "player-b", "guardian");
await service.setReady("battle-1", "player-a");
await service.setReady("battle-1", "player-b");
await service.startBattle("battle-1");

await service.submitAction("battle-1", {
  playerId: "player-a",
  commandId: "command-1",
  roundNo: 1,
  skillText: "破风斩",
  perfection: 90, // 可省略，默认 100；只影响直接伤害和 DOT 伤害
}); // WAITING_COMMAND -> SETTLING
const current = await service.getBattle("battle-1");
if (current.ok) {
  await service.advance("battle-1", { expectedVersion: current.version });
}
```

所有查询返回深拷贝快照。调用方不能提交伤害、治疗、护盾、状态或胜负结果，也不能通过修改返回对象影响真实对局。

`InMemoryBattleRepository`
只用于测试和单进程开发。生产环境必须让所有服务实例使用同一个
`SupabaseBattleRepository`；迁移 `20261024160000_battle_sessions.sql` 以
`battle_id` 为主键保存快照，并通过版本号 CAS 原子更新。不同设备只要提交相同的
`battleId`，就会读取同一条权威记录。阶段推进建议携带查询所得的
`expectedVersion`，避免重复请求跨过两个阶段。

运行对局内核测试：

```bash
deno task test:battle
```

通过公开会话接口模拟一局完整对战：

```bash
deno task sim:battle
```

## 协作

提交、Issue 和 PR 见 [CONTRIBUTING.md](CONTRIBUTING.md)。
