# 烈焰燎原

双方同时念咒语的对战游戏。谁先把当前角色的一句技能完整送到服务器，谁的技能结算，并打断对方还没念完的那一招。念得越准，直接伤害越高。生命、护盾、状态和胜负由服务器裁决。主持只播报已经结算的结果。

Web 是完整体验：学习技能、对电脑、玩家联机。灵矽是第一个智能硬件终端，规则与 Web
相同，并支持一台设备上的同机双人，用角色声音把整局念出来。离开灵矽，在 Web
上仍能学完技能、打完一局。

## 怎么打

战前选定一名角色，本局锁定。首发四名角色默认可免费使用：

| 角色     | 定位       |
| -------- | ---------- |
| 烈焰剑士 | 进攻爆发   |
| 圣光守卫 | 防守续航   |
| 暗影术士 | 增益循环   |
| 风行弓手 | 减益和限制 |

每人 7
个技能。基础技能不能连续两回合使用，其余技能大多每局成功施放一次。短技能用来抢先打断，长技能收益更高，也更容易在念完前被打断。服务器只接受与标准技能名完全一致的句子。

| 入口     | 终端                   | 做什么                     |
| -------- | ---------------------- | -------------------------- |
| 学习     | Web、灵矽              | 练技能名和完成度，不计胜负 |
| 对电脑   | Web、一台灵矽          | 打完一局                   |
| 同机双人 | 一台灵矽               | 声纹区分两位玩家           |
| 联机     | Web 对 Web，或两台灵矽 | 四位房间号，各自选角       |

一方生命到 0、另一方还在，存活方胜。分不出先后是平局。认输、主动离开，或断线超过
10 秒，对方胜。

## 文档

四份文档各管一块。冲突时，范围和商业以产品为准，裁决以玩法为准，说法以交互为准。

| 文档                                | 定什么                         |
| ----------------------------------- | ------------------------------ |
| [产品设计](docs/设计文档.md)        | 终端、功能范围、主流程、商业   |
| [玩法设计](docs/gameplay-design.md) | 角色、技能、打断、完成度、胜负 |
| [交互设计](docs/交互设计.md)        | 主持词、口令和一场时序         |
| [架构设计](docs/架构设计.md)        | 部署、存储、接口和模型边界     |

## 本地运行

浏览器：

```bash
cd web
npm install
npm run dev
```

页面在 `http://localhost:3000`。未配置 Supabase
时，对局放在本进程内存里。生产环境需要
`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 和
`WEB_SESSION_SECRET`。语音识别和合成使用 [`.env.example`](.env.example)
里的七牛变量。

灵矽接入的对局服务：

```bash
deno task dev
```

默认监听 `8787`，SSE 地址是 `http://<主机>:8787/mcp`。未设置
`MCP_CONNECTION_KEY` 时 `/mcp` 返回
401。未配置数据库时使用单进程内存；多实例共用同一份 Postgres，变量见
`.env.example`。同机双人把 `MCP_VOICEPRINT` 设为 `1`。

```bash
deno task test          # 全部测试
deno task test:battle   # 对局内核
deno task sim:battle    # 用公开会话接口走完一局
deno task check         # 格式、lint 和测试
```

灵矽边缘函数：

```bash
supabase login
export SUPABASE_PROJECT_REF=<project-ref>
export MCP_CONNECTION_KEY=<灵矽 MCP 连接密钥>
sh scripts/deploy_supabase.sh
```

部署后的 SSE 地址形如
`https://<project-ref>.supabase.co/functions/v1/game/mcp`。

## 代码

当前产品以 `src/engine` 为权威。请求从 `BattleSessionService`
进入，调用方提交技能原文和完成度。

| 路径                                | 内容                                 |
| ----------------------------------- | ------------------------------------ |
| `src/engine`                        | 规则、角色技能、对局服务、主持、时钟 |
| `src/adapter/mcp`                   | 灵矽 MCP                             |
| `src/adapter/http`                  | Web 对局编排和大厅                   |
| `src/speech`                        | 七牛语音                             |
| `web`                               | Next.js 界面和 BFF                   |
| `src/game`、`src/battle`、`src/mcp` | 上一套对局，保留备查                 |

## 协作

提交、Issue 和 PR 见 [CONTRIBUTING.md](CONTRIBUTING.md)。
