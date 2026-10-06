# 四人固定将牌吃墩规则服务（TypeScript + Node.js + SQLite）

一个**纯后端**（HTTP API + CLI）的离线吃墩规则核验服务。只负责：合法出牌校验、必须跟牌（follow suit）判断、将牌优先的墩结算、剩余手牌与赢墩统计。

不包含：叫牌、桥牌计分、AI 策略、随机发牌、联网对战。所有手牌对本地使用者可见，**不提供隐藏信息安全保证**，不是在线对战平台。

## 环境要求

- Windows + [Node.js](https://nodejs.org/) **18 岁以上版本即可**；本机实测 **Node v25.5.0 / npm 11**。
- SQLite 使用 Node 内置模块 [`node:sqlite`](https://nodejs.org/api/sqlite.html)，**无需 C++ 编译、无需 better-sqlite3、无需 Docker/WSL**，不访问任何外部在线服务。

> Node 22.5+ 提供 `node:sqlite`（实验模块）。如启动时看到 `ExperimentalWarning` 可忽略，或设置环境变量
> `NODE_OPTIONS=--disable-warning=ExperimentalWarning` 静默。

## 安装与构建

```powershell
npm install
npm run build
```

## 简化规则

- 固定四个座位 `0/1/2/3`，出牌顺序沿座位方向循环，整局不变。
- 卡牌编号 = 花色 + 点数：花色 `S` 黑桃、`H` 红桃、`D` 方块、`C` 梅花；点数 `2..10,J,Q,K,A`，**A 最大**。每张牌按原始身份唯一保存，不因同点数合并。
- 建局时直接给定每人手牌、首墩先手 `leader`、固定将牌花色 `trump`（`S/H/D/C`，无将用 `NT`）。每人牌数必须相等；可用少量牌的缩小牌组。
- 每墩第一张牌的花色为**引领花色**。其后玩家只要手中还有该花色就**必须跟同花色**；没有时才能垫任意其他花色。
- 四张出齐才结算：墩中出现将牌时，**最大将牌**赢；否则**最大引领花色牌**赢。异花色非将牌即使点数更大也不能赢。
- 赢家成为下一墩先手。全部手牌打完全局结束，给出每人赢墩数，赢墩总数等于实际墩数。
- 出牌必须带 `requestId`：相同编号 + 相同内容的重试幂等返回、不重复消耗；相同编号但内容不同返回冲突。

## CLI 命令

所有命令都操作项目内 SQLite 文件，默认 `data/games.db`（可用 `--db` 或环境变量 `TRICKSTER_DB` 覆盖）。各局数据互相隔离，新建局不改旧局。

```powershell
# 启动 HTTP 服务（默认自动选择空闲端口，也可 --port 指定）
npm start
node dist/src/cli.js serve --port 8080

# 内置演示：黑桃为将 S3 将吃 / 无将 HA 获胜 / 有红桃却出黑桃被拒 / 幂等重试
npm run demo

# 建局（hands 为 4 个座位的卡牌数组）
node dist/src/cli.js create --trump S --leader 0 --hands '[[\"H10\",\"S2\"],[\"H2\",\"S4\"],[\"S3\",\"D4\"],[\"HA\",\"D5\"]]'

node dist/src/cli.js state 1          # 查看手牌、当前墩、轮次、赢墩（--hide-hands 可隐藏手牌）
node dist/src/cli.js legal 1          # 当前轮次/引领花色/每张候选牌为何可出或不可出
node dist/src/cli.js play 1 --seat 0 --card S2 --requestId req-001
node dist/src/cli.js tricks 1         # 已结束墩：四张顺序、比较说明、赢家
node dist/src/cli.js replay 1         # 从初始发牌+成功事件重放核验（只读，不写新事件）
node dist/src/cli.js export 1         # 导出不可变初始手牌、规则与事件
```

## HTTP API

服务监听 `127.0.0.1`。请求/响应均为 JSON（UTF-8）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET`  | `/health` | 健康检查 |
| `POST` | `/api/games` | 建局，body：`{hands, leader, trump}` |
| `GET`  | `/api/games/:id/state` | 手牌与局面（`?hideHands=1` 隐藏手牌） |
| `GET`  | `/api/games/:id/legal` | 当前轮次、引领花色、候选牌逐条解释 |
| `POST` | `/api/games/:id/plays` | 出牌，body：`{seat, card, requestId}` |
| `GET`  | `/api/games/:id/tricks` | 历史墩明细 |
| `POST` | `/api/games/:id/replay` | 重放核验（不写入） |
| `GET`  | `/api/games/:id/export` | 导出不可变记录 |

出牌示例：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/games/1/plays `
  -Method Post -ContentType 'application/json' `
  -Body '{"seat":0,"card":"S2","requestId":"req-001"}'
```

## 错误码

响应体形如 `{"error":{"code":"...","message":"..."}}`。

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `UNKNOWN_SUIT` / `UNKNOWN_RANK` / `UNKNOWN_TRUMP` | 未知花色/点数/将牌 |
| 400 | `INVALID_HANDS` / `INVALID_LEADER` / `INVALID_SEAT` / `INVALID_REQUEST_ID` / `INVALID_JSON` / `INVALID_BODY` | 参数不合法 |
| 400 | `PLAYER_COUNT` | 人数不是恰好 4 |
| 400 | `UNEQUAL_HANDS` | 各人手牌数不等 |
| 400 | `DUPLICATE_CARD` | 跨手牌出现同一张牌 |
| 404 | `GAME_NOT_FOUND` | 局号不存在 |
| 409 | `NOT_YOUR_TURN` / `GAME_OVER` | 未轮到该玩家 / 局已结束 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一 requestId 内容不同 |
| 422 | `MUST_FOLLOW_SUIT` | 手中有引领花色却出别的花色 |
| 422 | `CARD_NOT_IN_HAND` | 该牌不在出牌者手中 |

## 原子性、并发与持久化

- SQLite 三张不可变表：`games`（规则）、`initial_hands`（初始手牌）、`play_events`（成功出牌事件，含 `request_id` 唯一约束）。
- 一次出牌的“重放校验局面 → 校验轮次/手牌/跟牌 → 追加事件”在单个 `BEGIN IMMEDIATE` 事务中完成；非法动作回滚，不消耗牌、不推进轮次。
- 并发提交同一轮的不同动作时，数据库写锁串行化，只有一个事务成功，其余收到 `NOT_YOUR_TURN`。
- 重启后直接从初始手牌与事件重放即可恢复到同一墩。`replay` 只读重算并比对，不写入新事件。
- 不变式：**初始牌集 = 剩余手牌 ∪ 当前墩 ∪ 历史墩**（测试中逐张核对）。

## 测试

覆盖：无将结算、将牌领出、多个将牌取最大、将吃、错误玩家、非法跟牌不消耗、重复请求幂等与冲突、最后一墩结束、跨手牌重复/人数/手牌不等校验、初始牌集合不变式、重放与重启一致、并发同轮仅一次成功。

```powershell
npm run build
npm test
```

## 项目结构

```
src/
  rules.ts   卡牌/花色点数、建局校验、候选牌解释、墩结算、从事件重放局面（纯函数）
  db.ts      SQLite 连接与不可变表结构
  store.ts   建局/局面/原子出牌(幂等+并发)/历史/重放/导出
  server.ts  零依赖 HTTP API（http 模块），默认自动选空闲端口
  cli.ts     CLI 入口
  demo.ts    内置演示局
test/
  rules.test.ts
data/        运行时数据库目录（自动创建，已被 .gitignore 忽略）
```

## 已知限制与假设

- 仅做后端，无前端界面；不校验牌组必须来自整副 52 张，允许任意缩小牌组（只保证跨手牌不重复、等量）。
- 不处理残局撤销、悔牌、叫牌或计分；事件只追加不删除。
- 所有手牌可被任何本地使用者查看，无信息隐藏/鉴权设计。
- `node:sqlite` 为 Node 内置实验模块，API 在未来大版本可能调整。
