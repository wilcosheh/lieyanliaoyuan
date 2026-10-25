# 烈焰燎原

下面是当前仓库里能跑的 demo。新产品的范围、玩法、交互和架构见
[产品设计](docs/设计文档.md)、[玩法设计](docs/gameplay-design.md)、[交互设计](docs/交互设计.md)、[架构设计](docs/架构设计.md)。搬迁前的目录在
tag `old-demo`。

demo
里，两人用灵矽设备念咒对战。燎原是裁判：房间、吟唱、打断、血量和结算都在服务端。灵矽只负责听和说，通过对接本服务的云端
MCP
进出每一拍。两边听到的战报、咒语音效、对方原声和胜负，都从各自设备的喇叭出来。浏览器对局在
`web/`。

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

页面默认位于 `http://localhost:3000`。未配置 Supabase
时使用单进程内存仓库；生产环境需配置
`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`WEB_SESSION_SECRET`
和七牛语音环境变量。

`deno task dev` 听 `8787`，跑的是新引擎。灵矽的 SSE 地址要带连接密钥：

```text
http://<公网主机>:8787/mcp?key=<MCP_CONNECTION_KEY>
```

本机没有公网地址时用 Supabase 函数地址，配法见下面的部署一节。`deno task sim`
仍走旧咒语 demo，不经过这把密钥。

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

灵矽 MCP 建议这样填：

- 传输协议：Streamable HTTP（或 SSE，两者都支持）
- MCP URL：`https://<project-ref>.supabase.co/functions/v1/game/mcp?key=<MCP_CONNECTION_KEY>`
- Params 里的 `key`：同一把 `MCP_CONNECTION_KEY`（可与 URL 里的重复）
- 若控制台还要求 Authorization / 出现 `authorization header required`：Header 填
  `Authorization: Bearer <Supabase anon key>`。连接密钥继续放在 URL 的 `key`
  上，不要把 anon key 和连接密钥弄混。
- 不要填 `X-Linx-Device-Id`。

路径必须是 `/functions/v1/game/mcp`，不要截成 `/functions/v`，也不要用旧的
`/functions/v1/mcp`。

每台设备的提示词写死自己的 `device_id`。模型每次调用都原样传入。同机双人要先把
`MCP_VOICEPRINT=1` 配上，提示词里说明认得出说话人时再传 `seat` 为 `A` 或 `B`。

```text
你是烈焰燎原的报幕。这台设备的 device_id 是 device-甲。每次工具调用都传这个 device_id。
只使用 submit_lobby_text、submit_utterance、begin_cast、cancel_cast、ack_playback、wait_event。
没有 create_room、join_room、ready、cast。

玩家说选角、练习、对电脑、两个人、开房间、房间号、准备、再来一局、复盘：
调用 submit_lobby_text，text 填玩家原话。大厅里不要调用 begin_cast。

练习或战场里玩家念完整句：调用 submit_utterance，text 填原话。
看血、还有哪些技能、投降也走 submit_utterance。

只有已经在战场、玩家开始念咒时才调用 begin_cast。放弃这一句用 cancel_cast。

content 里的原文逐字播出。文本为空就沉默。不要自己倒数，不要改写玩家的话。
ack_required 为 true 时，念完调用 ack_playback，再按 wait 调用 wait_event。
wait 为 true 时调用 wait_event，等待同一次调用返回。被取消或失败就立刻再调一次。
```

`initialize` 也会带同一段报幕约束。电脑技能有地址时，设备执行 `funcs` 里的
`linx_play`。没有地址就不播放。首版不拉聊天记录，不播对方原声。

## 部署到 Supabase

边缘函数大约 150 秒会被网关掐断。对局快照和还没送到的主持句在 Postgres。SSE
所在的实例 `LISTEN mcp`。另一实例写入后 `NOTIFY`。SSE
断了，模型再调一次 `wait_event`，未送达的句子改绑到新的调用 id。

`DATABASE_URL` 用数据库直连，端口 5432。6543 的事务池化收不到 `LISTEN`。

```bash
supabase login
export SUPABASE_PROJECT_REF=<project-ref>
export MCP_CONNECTION_KEY=<灵矽 MCP 配置里的连接密钥>
export DATABASE_URL=<postgres 直连 URI>
export MCP_VOICEPRINT=0
sh scripts/deploy_supabase.sh
```

脚本会推迁移，写入 `PUBLIC_BASE_URL`、`MCP_CONNECTION_KEY`、`MCP_VOICEPRINT` 和
`DATABASE_URL`，并关闭 JWT 校验。部署完成后，灵矽 SSE URL 是：

```text
https://<project-ref>.supabase.co/functions/v1/game/mcp?key=<MCP_CONNECTION_KEY>
```

如果网关仍然要求 `apikey`，把项目的 anon key 填进灵矽 MCP 的 Header，不要填
service role。连接密钥走 URL 的 `key`，或者 `Authorization: Bearer`。

## 目录

```text
src/game/                    咒语 demo，不属于新架构。语音接入还在调用，改完即删
src/engine/                  对局内核。公开入口是 index.ts
  rules/                     校验和阶段推进，以及内部状态
  characters/                角色和技能
  service/                   按 battleId 串行执行
  store/                     快照仓库。内存实现和 Supabase
  narration/                 战报句子
  clock/                     到期判断。内核尚未调用
  delivery/                  这条发给谁。内核尚未调用
src/adapter/http/            Web 编排、大厅和语音命令
src/adapter/mcp/             灵矽 MCP。SSE、工具和房间
src/speech/                  七牛听写和合成
supabase/functions/game/     唯一进程入口。/v1 与 /mcp 都挂在这里
supabase/migrations/
web/                         Next.js 页面、录音和前端测试
docs/                        产品、玩法、交互、架构
scripts/                     sim 和 sim:battle
```

## 新对局内核

`src/engine`
只实现对局状态和规则，不处理客户端协议、提示文案或消息推送。请求处理代码应从
`src/engine/index.ts` 使用 `BattleSessionService`，不要为每个请求自行创建
`BattleController`，也不要直接调用 `state.ts` 的内部状态写方法。

`BattleStateMachine`
内部持有对局状态、回合状态、角色状态、状态效果、技能使用记录、事件序列和命令幂等记录，并提供无规则判断的增删改查。`BattleController`
只持有状态机实例和不可变规则配置，所有合法性判断完成后再调用状态机变更数据。外部获得的都是深拷贝快照。

```ts
import {
  BattleSessionService,
  InMemoryBattleRepository,
} from "./src/engine/index.ts";

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
