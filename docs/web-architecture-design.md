# Web 接入层与游戏界面架构设计

## 1. 设计结论

Web 端可以在当前项目上叠加 Next.js，并且这是推荐方案。

现有 Deno、Supabase Edge Function、MCP 和 `src/engine`
保持独立，在仓库根目录新增 `web/` Next.js 应用。Next.js 同时承担 Web 游戏界面和
Web BFF 接入层；MCP 仍由现有同事维护，后续只需要接入相同的
`BattleSessionService`。

```text
浏览器
  -> Next.js 页面和客户端组件
  -> Next.js Route Handler（Web BFF）
       -> 七牛 ASR/TTS（可选）
       -> BattleSessionService
            -> SupabaseBattleRepository
                 -> Postgres ly_battle

MCP 客户端
  -> 现有 Supabase MCP Function
  -> 后续由 MCP 负责人接入 BattleSessionService
```

Next.js 不应替换当前 Deno 服务，也不应让浏览器直接操作 Battle
状态或调用七牛接口。

## 2. 技术栈

### 2.1 Web 应用

- Next.js 当前稳定版，使用 App Router。
- React 和 TypeScript 严格模式。
- Tailwind CSS，用 CSS Variables 定义游戏主题变量。
- Lucide React，用于按钮和状态图标。
- TanStack Query，负责服务端状态、轮询、缓存失效和请求去重。
- Zod，校验 Route Handler 输入、七牛响应和公开 DTO。
- AudioWorklet，采集 `16kHz / 单声道 / PCM16 WAV` 语音。
- Web Speech API，支持时直接在浏览器完成普通话识别。
- Vitest、React Testing Library 和 Playwright。

首版不引入全局客户端状态库。服务器状态放在 TanStack Query，录音流程使用
`useReducer`，音频缓冲和实时音量放在 `ref`，避免高频数据导致 React 重渲染。

### 2.2 服务端和存储

- Next.js Route Handler 作为 Web BFF。
- Route Handler 使用 Node.js Runtime，不使用 Next Edge Runtime。
- `BattleSessionService` 是唯一对局规则入口。
- `SupabaseBattleRepository` 保存权威对局快照。
- Web BFF 签发带 HMAC 的 HttpOnly 匿名会话 Cookie，签名中的玩家 ID
  作为可信身份。
- 七牛 ASR/TTS 通过服务端 `fetch` 调用，密钥只保存在服务端环境变量。

选择 Node.js Runtime 的原因是语音上传、二进制响应、超时控制和后续音频处理在 Node
Runtime 中更稳定，也避免受到 Edge Runtime API 和请求体限制影响。

## 3. 仓库目录

```text
lieyanliaoyuan/
  src/
    battle/                       现有纯对局内核
    mcp/                          现有 MCP 接入层
    web/                          框架无关的 Web 应用服务
      battle_application.ts      Web 对局流程编排
      battle_view.ts             内部状态转玩家视图
      dto.ts                      Web DTO
      narration.ts               战斗事件转播报文本
      speech/
        provider.ts              ASR/TTS 接口
        qiniu_provider.ts        七牛实现

  web/                            新 Next.js 应用
    app/
      page.tsx                    匹配首页
      prepare/[battleId]/page.tsx
      battle/[battleId]/page.tsx
      result/[battleId]/page.tsx
      api/web/v1/                 Route Handlers
    src/
      api/                        浏览器 API Client
      audio/                      AudioWorklet 和播放队列
      battle/                     战斗组件、hooks 和事件动画
      matchmaking/               匹配和准备组件
      auth/                       Supabase 匿名认证
    public/
    package.json
    next.config.ts
    tsconfig.json
```

`src/adapter/http` 不依赖 Next.js，可以被本地 Deno 服务、Next Route Handler
或以后新增的其他协议适配器复用。`web/app/api` 只负责 HTTP、认证和 DTO 转换。

Next 客户端组件禁止直接导入 `src/engine`。只有标记为 `server-only`
的服务端模块可以调用
`BattleSessionService`，避免规则代码和服务端密钥进入浏览器包。

## 4. Next.js 与现有项目的组合方式

### 4.1 本地开发

```text
Next.js: http://localhost:3000
Deno MCP: http://localhost:8787/mcp
```

Web 页面调用同源 `/api/web/v1`，不需要跨域。MCP 仍然运行现有
`deno task dev`，两套服务互不影响。

### 4.2 生产部署

- Next.js 部署到 Vercel，根目录是 `web`。生产分支 `main`
  的推送会发布生产，其他分支发布预览。
- MCP 继续部署到现有 Supabase Function。
- 两者连接同一个 Supabase Postgres。
- Next.js 使用 `SUPABASE_SERVICE_ROLE_KEY`
  访问对局仓库，但该密钥不能暴露给浏览器。
- Web BFF 使用 `WEB_SESSION_SECRET`
  校验匿名会话签名，再检查数据库中的对局成员关系。

不建议把 Next.js 构建产物塞进 Supabase MCP
Function。两者运行时、部署频率、认证方式和超时特征不同，强行合并会增加故障影响范围。

## 5. Web BFF API

基础路径为 `/api/web/v1`。

| 方法     | 路径                                  | 用途                       |
| -------- | ------------------------------------- | -------------------------- |
| `POST`   | `/sessions`                           | 创建或恢复匿名玩家会话     |
| `POST`   | `/matchmaking/tickets`                | 加入匹配                   |
| `GET`    | `/matchmaking/tickets/:id`            | 查询匹配结果               |
| `DELETE` | `/matchmaking/tickets/:id`            | 取消匹配                   |
| `GET`    | `/characters`                         | 查询角色和技能展示配置     |
| `GET`    | `/battles/:id`                        | 查询玩家视角快照和增量事件 |
| `POST`   | `/battles/:id/character`              | 选择角色                   |
| `POST`   | `/battles/:id/ready`                  | 准备或取消准备             |
| `POST`   | `/battles/:id/actions/voice`          | 上传录音并发动技能         |
| `POST`   | `/battles/:id/actions/recognized`     | 提交浏览器语音识别结果     |
| `GET`    | `/battles/:id/events/:sequence/audio` | 获取事件 TTS 播报          |

以下 Battle 方法只能由 Web 应用服务调用，不能直接暴露为客户端接口：

- `createBattle`
- `startBattle`
- `advance`
- `archiveBattle`

浏览器不能提交 `playerId`、技能 ID、`perfection`、伤害、状态或胜负。`playerId`
来自服务端签名会话。Web Speech API 模式只提交识别文本和原始 `0-1` 置信度，服务端
负责标准化文本、换算完美度并调用对局控制层；七牛模式仍由服务端从录音生成识别结果。

## 6. 玩家公开视图

当前 `BattleState` 包含 `processedCommands`
和完整内部事件，不应原样返回浏览器。Web 接入层需要生成玩家视角 DTO：

```text
WebBattleView
- battleId
- version
- status
- roundNo
- roundStatus
- self
- opponent
- availableSkills
- eventsAfterCursor
- winner
```

`availableSkills` 必须由服务端根据 Battle 规则计算，包含：

- 技能 ID、名称和描述。
- 是否可用。
- 剩余次数。
- 不可用原因。
- 名称长度和技能效果展示数据。

前端不能复制基础技能连续使用、技能次数和状态限制判断。

## 7. 语音发动技能

浏览器采用按住说话、松开提交，提供两种输入模式：

- 浏览器模式：使用 Web Speech API 识别普通话，提交识别文本和可选置信度。
- 七牛模式：使用 AudioWorklet 录制 WAV，通过服务端调用七牛 Dora 短语音听写。

七牛模式请求使用 `multipart/form-data`：

```text
commandId
roundNo
audio.wav
```

浏览器模式请求使用 JSON：

```text
commandId
roundNo
transcript
confidence（可选，0-1）
```

两种模式共用的服务端流程：

```text
校验签名会话和对局成员
-> 快速检查当前回合是否仍可提交
-> 检查语音命令幂等记录
-> 七牛模式调用 Dora；浏览器模式校验 transcript 和 confidence
-> 标准化 transcript
-> 服务端计算 0-100 perfection
-> BattleSessionService.submitAction
-> 行动成功后服务端推进战斗阶段和回合结束阶段
-> 返回最终快照及本次产生的完整事件序列
```

两个玩家同时提交时，以识别完成后成功写入 Battle
状态的顺序为准。客户端时间戳不能决定胜负，也不设置防抖窗口。

### 7.1 ASR 完美程度

七牛适配器统一返回：

```ts
type SpeechRecognitionResult = {
  transcript: string;
  perfection: number;
  providerRequestId?: string;
  confidenceSource: "provider" | "fallback";
};
```

规则如下：

- Dora 短语音听写响应不提供可用于伤害计算的置信度，首版固定回退为 `100`。
- `confidenceSource` 固定为 `fallback`，用于明确该数值不是服务商置信度。
- Web Speech API 返回有效 `0-1` 置信度时，由服务端乘以 100
  并四舍五入；未返回时回退为 `100`。
- 服务端仍保留 `0-100` 的 `perfection`
  字段，便于后续更换支持置信度的模型时兼容对局接口。
- 提交战斗核心前，Web 接入层移除识别文本中的空白以及首尾标点。例如 `破 风 斩。`
  会按 `破风斩` 校验；同音错字、近似文本和其他角色技能不会被纠正或接受。
- 匹配失败时接口返回
  `ASR_FAILED`，并在错误详情中携带实际识别文本，供界面明确提示玩家。

不能用技能文字编辑距离生成完美程度，因为技能名称要求精确匹配，文字匹配和语音质量是两个不同概念。

### 7.2 ASR/TTS 服务接口

```ts
interface SpeechProvider {
  recognize(input: {
    audio: Uint8Array;
    contentType: string;
  }): Promise<SpeechRecognitionResult>;

  synthesize(input: {
    text: string;
    voice?: string;
  }): Promise<{
    audio: Uint8Array;
    contentType: string;
  }>;
}
```

服务端环境变量：

```text
WEB_SESSION_SECRET
QINIU_DORA_ASR_URL
QINIU_DORA_ACCESS_KEY
QINIU_DORA_SECRET_KEY
QINIU_AI_BASE_URL
QINIU_AI_API_KEY
QINIU_TTS_MODEL
QINIU_TTS_VOICE
```

ASR 使用七牛 Dora 短语音听写：服务端将浏览器上传的音频做标准 Base64 编码， 以
`audioBase64`、`lang=MANDARIN`、`scene=GENERAL` 调用 `/v2/asr`，并使用
七牛账户的 AccessKey/SecretKey 生成 QiniuToken。Dora 不返回置信度，因此完美程度
按规则回退为 100%。Dora AK/SK 与 `sk-` 开头的 AI 大模型 API Key 不是同一种凭据。

TTS 是独立可选能力。未配置 TTS 时只影响战报语音播报，不阻塞录音转写、行动提交或
回合推进。具体 TTS 模型 ID、响应格式由 `QiniuSpeechProvider` 在 Web 层适配，
不进入 Battle 层。

## 8. TTS 播报

TTS 是文字转语音，只用于播报服务器生成的战斗事件。客户端不能提交任意文本调用
TTS，否则会产生费用和内容安全风险。

```text
BattleEvent
-> 服务端 narration.ts 生成固定中文播报
-> 七牛 TTS
-> 返回带 Cache-Control 的音频
-> 浏览器按 event.sequence 顺序播放
```

TTS 失败不能阻塞战斗状态推进。浏览器继续显示文字战报，并允许玩家继续下一回合。

## 9. 回合推进编排

Web 客户端只负责发动技能，不能调用 `advance`。新增 `WebBattleApplication`：

```text
submitAction
-> SETTLING
-> advance(expectedVersion)
-> ENDING 或 FINISHED
-> 未结束则 advance(expectedVersion)
-> 下一回合 WAITING_COMMAND
```

接口返回最终权威快照和中间产生的事件。前端按事件顺序播放动画，因此不需要让中间状态长时间停留在数据库中。

如果请求在接受行动后意外中断，读取对局或后台恢复任务可以检测 `SETTLING/ENDING`
并继续推进。版本号 CAS 保证多个实例同时恢复时只有一个写入成功。

## 10. 实时同步

首版使用版本轮询：

- 战斗阶段每 `300-500ms` 查询一次。
- 准备阶段每 `1s` 查询一次。
- 浏览器进入后台后降低频率。
- 请求携带 `afterSequence` 和上一版 `version`。
- 版本未改变时返回 `304` 或空增量结果。

行动抢占直接走 HTTP
请求，不依赖轮询，因此轮询延迟只影响画面刷新，不影响谁先行动。后续可以替换为
Supabase Realtime，Battle 接口和前端事件模型不需要改变。

## 11. 游戏界面

### 11.1 匹配页

- 昵称和玩家标识。
- 快速匹配按钮。
- 匹配等待状态和取消按钮。
- 麦克风权限预检。

### 11.2 准备页

- 四个角色选择区域。
- 当前角色的七个技能列表。
- 技能名称长度、效果、使用次数和定位。
- 双方角色及准备状态。
- 准备按钮。

### 11.3 战斗页

- 顶部：对手角色、生命、护盾和状态效果。
- 中央：角色表现、技能动画和本回合结果。
- 底部：自身生命、护盾、技能列表和固定语音按钮。
- 语音按钮上方使用分段控件切换浏览器识别和七牛识别；默认选择浏览器识别。
- 侧边或抽屉：按事件序列排列的战斗日志。
- 识别中显示音量和处理状态，不显示客户端推测的伤害结果。

界面使用服务端快照作为唯一权威数据。生命、护盾、技能次数和状态不做乐观更新。

### 11.4 结算页

- 胜负结果。
- 使用角色和总回合数。
- 关键技能和伤害事件。
- 返回准备阶段按钮。

## 12. Web 客户端状态

语音输入状态机：

```text
IDLE
-> REQUESTING_PERMISSION
-> RECORDING
-> ENCODING
-> UPLOADING
-> RECOGNIZING
-> SUBMITTING
-> ACCEPTED / REJECTED
-> IDLE
```

只有服务器快照为
`WAITING_COMMAND`、角色可行动且本地没有未完成请求时才允许开始录音。对手抢先后，正在处理的请求最终由服务器返回
`ROUND_ALREADY_WON`。

## 13. 安全和幂等

- 七牛和 Supabase 服务端密钥不进入 `NEXT_PUBLIC_*` 环境变量。
- 每个接口验证签名会话、对局成员和当前玩家身份。
- 对 `(battle_id, command_id)` 建立唯一语音命令记录。
- 两种识别方式共用命令幂等记录；同一命令重试不重复结算，也不重复产生七牛费用。
- 浏览器识别文本仍须通过服务端的技能精确匹配、可用次数和当前回合校验。
- 限制音频 MIME、采样率、大小和单段时长。
- ASR/TTS 设置明确超时，失败不修改 Battle 状态。
- 不长期保存原始录音；如需排障留存，必须单独配置保留时间和用户告知。
- TTS 只能播报服务端生成的文本。
- 对语音、匹配和状态查询分别做玩家与 IP 级限流。

建议新增：

```text
web_match_ticket
web_battle_member
web_voice_command
```

其中 `web_voice_command` 记录 `RECEIVED / RECOGNIZED / SUBMITTED / FAILED`
状态、ASR 结果和最终业务响应。

## 14. 测试方案

### 14.1 后端

- 使用 Fake SpeechProvider 测试所有 Web API。
- 七牛请求和响应使用固定契约样本测试。
- ASR 超时、业务错误和空转写不能消耗技能或回合。
- 同一 `commandId` 重试不能重复调用 ASR 或重复结算。
- 两个玩家并发提交语音时只能有一方获得行动权。
- 接口不能越权读取或操作其他对局。
- `advance`、伤害和状态修改不能从 Web API 直接调用。

### 14.2 前端

- Vitest 和 React Testing Library 覆盖录音状态机、技能状态和错误展示。
- 使用浏览器 API 假实现覆盖 Web Speech 配置、识别结果和错误分支。
- Playwright 使用两个 Browser Context 模拟两个玩家。
- 测试匹配、选角、准备、并发行动、回合推进、重连和终局。
- 使用固定 WAV 样本验证上传，不在普通 CI 中调用真实七牛产生费用。
- 独立的受控集成环境验证真实七牛 ASR/TTS。

## 15. 实施顺序

1. 建立 `web/` Next.js 工程、Supabase 匿名认证和基础布局。
2. 实现框架无关的 `src/adapter/http` 应用服务和公开 DTO。
3. 实现匹配、对局查询、选角和准备 Route Handler。
4. 使用 Fake SpeechProvider 打通双浏览器完整对局。
5. 接入七牛 Dora 短语音听写，并验证转写文本和 100% 完美度回退规则。
6. 接入事件 TTS 和浏览器播放队列。
7. 完成并发、幂等、断线恢复和真实 API 回归测试。
8. 增加 Web 构建、测试和部署 CI。
