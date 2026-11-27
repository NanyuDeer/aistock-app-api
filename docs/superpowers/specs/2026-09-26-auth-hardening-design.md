# 密码认证加固设计（auth-hardening）

- 日期：2026-09-26
- 仓库：`aistock-app-api`
- 范围：`src/modules/auth`（密码注册 / 密码登录 / 防刷计数 / 密码工具）
- 关联：
  - 前置变更 `296154b`（密码登录防刷松绑：仅账号维度、`FAIL_MAX` 2→10、429 不降级）
  - 前端同期 spec `aistock-app-frontend/docs/superpowers/specs/2026-09-26-app-password-auth-revision-design.md`
- 交付方式：完整 spec + plan（本文件 → 自审 → 用户审阅 → `writing-plans`）
- 状态：待用户审阅

---

## 1. 背景

前置变更（`296154b`）已修复「密码登录被限流后降级验证码」与「存量账号无密码」两大问题。复核代码后仍存在 4 项后端遗留问题（编号 I1–I4）与 1 处文档债务。本设计一次性收敛。

问题清单（均已在当前代码中定位到 `文件:行`）：

| 编号 | 问题 | 定位 | 影响 |
|------|------|------|------|
| I1 | `verifyPassword` 对 `stored` 为空时提前 `return false`，不执行任何 scrypt | [passwordUtils.ts:27](file:///d:/aistock/aistock-app-api/src/modules/auth/passwordUtils.ts#L27) | 时间侧信道：可据响应耗时区分「账号不存在/未设密码」与「密码错误」，与「口径统一不暴露账号存在性」的目标相矛盾 |
| I2 | 内存兜底 `Map` 无过期清理、无容量上限 | [loginThrottle.ts:27-45](file:///d:/aistock/aistock-app-api/src/modules/auth/loginThrottle.ts#L27-L45) | Redis 不可用时，随机账号洪泛可无界增长内存（DoS） |
| I3 | `isStrongPassword` 只有长度下限 8，无上限 | [passwordUtils.ts:61-63](file:///d:/aistock/aistock-app-api/src/modules/auth/passwordUtils.ts#L61-L63) | 超长密码进入 `scryptSync`，CPU/内存放大 |
| I4 | `register` 先 `hashPassword`（昂贵 scrypt）后 upsert；已设密码账号仍白白计算一次散列 → 409 | [PasswordAuthController.ts:95-120](file:///d:/aistock/aistock-app-api/src/modules/auth/PasswordAuthController.ts#L95-L120) | 无谓 CPU 开销；注册无独立频控，易被刷 |
| D1 | 模块文档仍保留修订前口径 | [auth/AGENTS.md:22](file:///d:/aistock/aistock-app-api/src/modules/auth/AGENTS.md#L22)、[auth/AGENTS.md:41](file:///d:/aistock/aistock-app-api/src/modules/auth/AGENTS.md#L41) | 文档与实现不符（仍写「同账号/同 IP」「提示改用验证码登录」） |

---

## 2. 目标与非目标

### 目标
1. **I1**：`verifyPassword` 在执行成本上不因 `stored` 为空而走捷径，消除时间侧信道。
2. **I2**：内存兜底 Map 具备过期清理与容量上限，Redis 不可用时不被无界写入拖垮。
3. **I3**：密码长度设上限（含注册与登录入口），阻断超长输入引发的 CPU/内存放大。
4. **I4**：注册路径避免对已设密码账号做无用 scrypt；注册新增独立账号维度频控；收紧注册验证码的测试后门作用域。
5. **D1**：修正 `auth/AGENTS.md` 中与实现不符的口径描述。

### 非目标（明确排除）
- 不改动 401/429 的业务口径与文案（I2 选「统一计数」，不因 I1/I2 改变对外的状态码与 message）。
- 不引入新依赖（继续零依赖 scrypt）。
- 不重构 Redis/内存双写框架，不把 `loginThrottle` 改为通用限流中间件。
- 项目级 `NODE_ENV !== 'production'` 测试后门（见 §4.5）**本次一并收口**：收紧密码注册/登录路径后，其余两处（`EmailAuthController.bindWechat` 内联判定、`ws/handler.parseUserFromToken`）已于同日作为独立变更（plan Task 10）收紧为仅 `NODE_ENV=test` 生效（见 §10.C）。
- 不改前端仓库（如需前端联动，另立事项）。

---

## 3. 现状关键代码

### 3.1 登录防刷 [`loginThrottle.ts`](file:///d:/aistock/aistock-app-api/src/modules/auth/loginThrottle.ts)
- 常量：`FAIL_WINDOW_SEC = 900`、`FAIL_MAX = 10`、`ACCT_PREFIX = 'auth:pwfail:acct:'`。
- `redisAvailable` 由 `ping()` 与 `connect`/`error` 事件维护。
- 内存兜底 `memoryFail = Map<string, {count, expireAt}>`：读取时惰性过期判断，但**从不主动删除、无容量上限**。
- `redisIncr`：先 `INCR` 再在 `count === 1` 时 `EXPIRE`（非原子，属已知 M 级项，本设计不改）。

### 3.2 密码工具 [`passwordUtils.ts`](file:///d:/aistock/aistock-app-api/src/modules/auth/passwordUtils.ts)
- `hashPassword`：`scrypt$N$r$p$salt$hash`，N=16384/r=8/p=1/keylen=64/salt=16B。
- `verifyPassword(password, stored)`：`stored` 为空直接 `false`；否则严格解析 + 上界校验后 `scryptSync` + `timingSafeEqual`。
- `isStrongPassword`：`length >= 8 && 含字母 && 含数字`。

### 3.3 控制器 [`PasswordAuthController.ts`](file:///d:/aistock/aistock-app-api/src/modules/auth/PasswordAuthController.ts)
- `verifyCode`（L54-59）：`isDev = NODE_ENV !== 'production'`，命中 `SMS_DEV_TEST_CODE`/`EMAIL_DEV_TEST_CODE`（均为 `'123456'`）即通过。
- `register`（L73-145）：解析身份 → 强度校验 → 验证码校验 → `hashPassword` → 原子 upsert（`ON CONFLICT ... DO UPDATE ... WHERE users.password_hash IS NULL`，0 行 → 409）。
- `passwordLogin`（L147-214）：`isThrottled` → 429；查询 `password_hash`；`verifyPassword`；失败 `recordFailure` + 401；成功 `clearAccountFailure` + 签发。

### 3.4 已完成的关联项（不在本次范围）
- B1「存量账号无密码」已实现：注册 upsert 首设密码；`/users/me` 已返回 `hasPassword`（[userController.ts:139](file:///d:/aistock/aistock-app-api/src/modules/auth/userController.ts#L139)）。

---

## 4. 设计决策

### 4.1 I1 — 恒定成本校验

**决策**：新增 `verifyPasswordConstantTime(password, stored)`，在 `stored` 为空时对一个**模块级 dummy 散列**执行等价成本的 scrypt，再返回 `false`；`stored` 非空时复用现有解析校验逻辑。**`verifyPassword` 现有语义保持不变**（`stored` 空仍返回 `false`），仅新增函数供登录路径使用。

**签名**：
```ts
// 命中空 stored 时，对 dummy 散列执行同参数 scrypt，保证耗时与「有散列」路径一致
// （2026-09-27 修订：改为异步，返回 Promise<boolean>，见 §10 B）
export function verifyPasswordConstantTime(password: string, stored: string | null): Promise<boolean>;
```

**实现要点**：
- 模块加载时计算一次 `DUMMY_STORED = hashPassword('__dummy__')`（同样 N/r/p/keylen），避免每次请求重复构造。
- 空分支：调用内部同参数 `scryptSync(password, dummySalt, dummyKeylen, {N,r,p})`，**丢弃结果**，随后 `return false`。耗时与正常路径同量级。
- 非空分支：直接复用 `verifyPassword` 的解析与比对（含上界校验），避免逻辑重复。
- 失败（解析异常等）路径同样不应短路到「零成本」，但非法/被篡改串属异常输入，允许快速返回 `false`（与现状一致），**§5 记录为已知取舍**。

> **2026-09-27 修订（见 §10 B）**：scrypt 调用全部异步化后，模块加载期无法再同步构造 dummy 散列；而 scrypt 成本只取决于 N/r/p/keylen（与口令、盐的具体取值无关），故 dummy 改为模块级固定随机盐 `DUMMY_SALT = crypto.randomBytes(SALT_BYTES)`，等价成本不变。同时 `hashPassword` 亦变为 `Promise<string>`，注册路径 `const hash = await hashPassword(password)`。

**调用点调整**：[PasswordAuthController.ts:187](file:///d:/aistock/aistock-app-api/src/modules/auth/PasswordAuthController.ts#L187)

现状为 `!!row && verifyPassword(password, ...)`——`!!row` 在账号不存在时短路，使该路径零成本。必须**去掉短路、始终调用**：
```ts
const passOk = verifyPasswordConstantTime(password, row?.password_hash ?? null);
```
这样「账号不存在」（`row` 为 `undefined` → `stored=null`）与「账号存在但密码错」两条路径都执行等价成本的 scrypt。注意不得写成 `!!row && ...` 形式，否则账号不存在路径仍零成本。

**备选方案（未采纳）**：
- A：把 `verifyPassword` 语义直接改为空 stored 也跑 dummy —— 会改变一个被多处引用的纯函数语义，风险外溢，弃用。
- B：登录恒做固定 sleep —— 引入人为延迟、且与真实 scrypt 成本不匹配，弃用。

### 4.2 I2 — 内存兜底 Map 的过期清理与容量上限

**决策（用户确认：统一计数 + 内存上限）**：
- 保留「账号维度统一计数」语义，**401/429 口径与文案完全不变**。
- 为 `memoryFail` 增加：
  1. **惰性清理 + 周期清扫**：当 `memoryFail.size` 超过阈值时触发一次全量清理，删除 `expireAt <= now` 的条目（避免 `setInterval` 常驻定时器带来的测试/退出困扰）。
  2. **容量上限 `MEMORY_MAX_ENTRIES`**：清理后若仍超上限，按 `expireAt` 升序（最旧先淘汰）删除至上限。
- 常量建议：`MEMORY_MAX_ENTRIES = 10000`（单条目约几十字节，约几 MB 量级）。

**实现要点**：
- 新增内部函数 `sweepMemory(now)`：先删过期，再按容量淘汰。
- 调用时机：`memoryIncr` 写入后调用（仅当 `size > MEMORY_MAX_ENTRIES` 时执行清扫，摊薄成本）。
- 随机账号洪泛场景下：内存占用被 `MEMORY_MAX_ENTRIES` 封顶；被淘汰条目的失败计数丢失，等价于「放宽对陌生账号的计数保留」——**属可接受**，因为真实攻击目标是账号维度，Redis 正常时不受影响。

**备选方案（未采纳）**：
- 纯 LRU 淘汰最近未使用：语义上「最久未访问」不如「最旧过期」贴合时间窗模型，弃用。
- 定时器周期清理：测试进程退出需清理定时器，易引入 flaky，弃用。

### 4.3 I3 — 密码长度上限

**决策**：新增 `MAX_PASSWORD_LENGTH = 128`，并在两个入口生效：
- `isStrongPassword` 增加 `password.length <= MAX_PASSWORD_LENGTH` 判定（注册入口自动覆盖）。
- `passwordLogin` 在进入 `scrypt` 之前，对超长密码直接按「口令错误」处理（**不新增对外码**，保持 401 口径）。

**常量**：
```ts
export const MAX_PASSWORD_LENGTH = 128;
```

**入口处理**：
- 注册：`isStrongPassword` 为 false → 现有 400「密码至少 8 位且需包含字母和数字」。为给出更准确反馈，注册分支可细分：长度 > 上限时返回 400「密码长度不得超过 128 位」，否则沿用现文案。若希望**最小改动**，也可直接复用现 400 文案——**采纳「细分文案」**，因为上限是新增约束，需可诊断。
- 登录：`typeof password === 'string' && password.length > MAX_PASSWORD_LENGTH` → 走与失败一致的分支（`recordFailure` + 401「账号或密码错误」），避免暴露「长度非法」这一区分信号。

**为什么上限取 128**：`scryptSync` 成本对输入长度近似线性，128 位足以覆盖任何正常口令（含密码管理器产物），同时把单次成本约束在可预期范围。

### 4.4 I4 — 注册提前判重 + 独立频控

**决策（用户确认：提前判重 + 注册频控）**：

**(a) 提前判重（避免无用 scrypt）**
在 `register` 中，验证码校验通过后、`hashPassword` 之前，先做一次轻量 `SELECT password_hash`：
- 若账号已存在且 `password_hash IS NOT NULL` → 直接 `409 该账号已设置密码`，跳过 `hashPassword`。
- 否则继续 `hashPassword` + 原子 upsert。
- **原子 upsert 仍为最终仲裁**：并发下即使提前判重漏网，upsert 的 `WHERE users.password_hash IS NULL` + 0 行 → 409 仍兜底。
- SELECT 失败不阻断主流程（降级为「不提前判重」，直接走 upsert），避免因新增查询引入新的 500 面。

**(b) 独立注册频控**
新增**注册专用**账号维度计数，与登录失败计数**完全隔离**：
- 计数器前缀独立，如 `auth:reg:acct:`，窗口 `REG_WINDOW_SEC = 900`，阈值 `REG_MAX = 5`。
- 超限返回 `429`「操作过于频繁，请稍后再试」。
- **不计入登录失败计数器**，避免首次设密码被误锁导致无法登录。
- 计数时机：注册请求（进入处理即计数，或仅在失败后计数）——**采纳「尝试即计数」**，因为目标是防刷注册接口本身；成功注册后 `clearRegisterCount` 复位。
  - **2026-09-27 修订（见 §10 A）**：终审发现「进入即计数」+ 仅账号维度可被他人用错验证码请求打满配额，使受害者首次设密码被 429。**修订为「验证码校验通过后计数」**：`isRegisterThrottled` 检查位置不变（仍在入口），`recordRegisterAttempt` 后移到 `verifyCode` 通过之后；成功注册后仍复位。未通过验证码的尝试不再占用配额。

**备选方案（未采纳）**：
- 复用登录失败计数器：会污染登录口径、可能误锁首次设密码，弃用。
- 仅靠验证码本身限频：注册要求验证码，但验证码发送侧限频与注册接口调用可能不一致，不足以覆盖，弃用。

**(c) 收紧测试后门作用域**
`PasswordAuthController.verifyCode` 的 `isDev` 判定由 `NODE_ENV !== 'production'` 收紧为 `NODE_ENV === 'test'`：
```ts
const isTest = process.env.NODE_ENV === 'test';
if (isTest && code === devCode) return true;
```
- 动机：只要生产环境 `NODE_ENV` 未显式设为 `'production'`（如 staging、容器漏配），万能码 `'123456'` 即生效，属真实风险。
- **作用域限定**：仅改密码注册/登录路径。`SmsAuthController`/`EmailAuthController`/`ws/handler` 等项目级同模式**本次不动**，登记为后续独立项（见 §7）。
- **代价**：本地 `NODE_ENV` 未设（development）时，手动测试注册需真实验证码。缓解：测试与 CI 均显式 `NODE_ENV=test`（现有 `password-auth.spec.ts` 的 `before` 已 `||=` 设置）；开发环境联调如需后门，应显式设 `NODE_ENV=test`。

### 4.5 D1 — 文档修正

- [auth/AGENTS.md:22](file:///d:/aistock/aistock-app-api/src/modules/auth/AGENTS.md#L22)：改为「密码登录（仅同账号维度防刷，15 分钟内失败达阈值返回 429，不降级验证码）」。
- [auth/AGENTS.md:41](file:///d:/aistock/aistock-app-api/src/modules/auth/AGENTS.md#L41)：改为「loginThrottle.ts — 登录失败计数（仅账号维度，Redis 优先 + 内存兜底）」。

---

## 5. 安全权衡与已知取舍（显式记录）

1. **目标账号恶意锁定**：账号维度计数意味着攻击者可故意对某账号打满失败次数使其 429。这是「防爆破」与「防误伤」之间的既有取舍，本设计**维持不变**（选「统一计数」）；Redis 可用时窗口 15 分钟后自然释放。
2. **非法存储串的快速失败**：`verifyPassword` 对被篡改/格式非法的 `stored` 仍快速返回 `false`（不跑 scrypt）。属异常输入，可接受；不构成对正常账号的时间侧信道。
3. **内存淘汰导致计数丢失**：容量上限下被淘汰的账号其失败计数归零，等于对该账号放宽限制。可接受（Redis 正常路径不受影响，内存兜底仅为降级态）。
4. **测试后门作用域一致性（已消除）**：原先仅收紧密码路径，其余控制器保留 `!== 'production'` 模式，属**已知不一致**并登记为后续项；该不一致已由同日独立变更（plan Task 10）消除，现所有测试后门统一为仅 `NODE_ENV=test` 生效（见 §10.C）。

---

## 6. 测试计划（TDD，先行编写）

测试框架：`node:test` + `tsx`；命令 `npm test`（`node --import tsx --test "src/**/__tests__/**/*.spec.ts"`）。沿用 `password-auth.spec.ts` 的「内存兜底 + 每例独立 account」策略避免模块级 Map 串扰。

### 6.1 `password-utils.spec.ts` 新增
- T1（I1）：`verifyPasswordConstantTime` 对 `null` 返回 `false`。
- T2（I1）：`verifyPasswordConstantTime` 对合法散列 + 正确密码返回 `true`，错误密码返回 `false`（正确性）。
- T3（I1）：`stored=null` 分支确实执行了散列。**主断言**：`verifyPasswordConstantTime('x', null) === false`（确定）。**辅断言**：该调用耗时处于同一量级的下界（取保守阈值，如 > 1ms；对比对象为同参数 `hashPassword` 平均耗时的一个宽松下界）。**flaky 缓解**：采用「远超纯比较成本」的保守下界而非精确区间；若在 CI 上仍不稳定，则以 §8.3 的代码审查作为 I1 的最终判定依据，测试保留确定性的主断言。
- T4（I3）：`MAX_PASSWORD_LENGTH === 128`；`isStrongPassword` 对 128 位合法口令 `true`、129 位 `false`。

### 6.2 `login-throttle.spec.ts` 新增
> 原则：**不为测试向生产代码添加 test-only 探针**（避免 `testing-anti-patterns`）。用行为断言验证容量淘汰。

- T5（I2 容量淘汰，行为断言）：
  1. 账号 A 连续 `recordFailure` × `FAIL_MAX` → 断言 `isThrottled(A) === true`（A 的 `expireAt` 此刻最早）。
  2. 灌入 `MEMORY_MAX_ENTRIES` 个互不相同的账号各 `recordFailure` × 1 → 触发清扫，按「最旧 `expireAt` 先淘汰」策略，A 应被淘汰。
  3. 断言 `isThrottled(A) === false`（A 计数被淘汰归零）。
  - 说明：仅导出 `MEMORY_MAX_ENTRIES` 常量（合法配置常量，非 test-only 方法）用于构造灌入规模。
- T6（I2 过期清理，行为断言）：若无法在测试内构造过期态（`expireAt` 由 `Date.now()+900s` 决定、不可注入），则降级为「T5 已覆盖淘汰路径」并**不强行断言过期**——在测试注释中说明该分支由 T5 的清扫逻辑共同覆盖，避免为可测性注入时钟。（若实现中可控注入 `now`，则补测：写入后推进虚拟时间 → 断言条目被清理。）

### 6.3 `password-auth.spec.ts` 新增
- T7（I3）：注册 129 位密码 → 400（新文案「密码长度不得超过 128 位」）。
- T8（I3）：登录超长密码 → 401「账号或密码错误」，且**不触发 500**。
- T9（I4a）：对已设密码账号再次注册 → 409，且**未调用 `hashPassword` 的 scrypt**（以 mock 计数或耗时断言；优先断言 upsert 未被调用 / SELECT 提前返回）。
- T10（I4b）：同账号注册请求超过 `REG_MAX` → 429；成功注册后计数复位。
- T11（I4c）：`NODE_ENV=test` 时万能码仍生效（现有用例已覆盖）；`NODE_ENV=development` 时万能码**不再生效**，走 `consumeCode`（mock 为 false → 400）。
- T12（回归）：现有全部用例保持通过（I1 改动不得破坏 401/429 口径与成功路径）。

---

## 7. 影响面与后续项

**影响文件**：
- `src/modules/auth/passwordUtils.ts`（I1、I3）
- `src/modules/auth/loginThrottle.ts`（I2、I4b 注册计数）
- `src/modules/auth/PasswordAuthController.ts`（I1 调用点、I3 登录分支、I4a/b/c）
- `src/modules/auth/AGENTS.md`（D1）
- 三个 spec 文件（新增用例）

**兼容性**：对外状态码/文案除「注册超长密码」新增 400 文案、「注册频控」新增 429 外均不变；前端 `app-frontend` 已在同期 spec 中约定注册/登录契约，需确认新 429/400 文案不破坏既有前端处理（前端按 code 分发，新增 400/429 文案可被通用错误提示覆盖）。

**后续独立项（不在本次实现）**：
- M1：`redisIncr` 的 `INCR`+`EXPIRE` 非原子（可改 `SET k 1 EX` + Lua 或 pipeline）。
- M3~M7：见既有后端遗留清单。
- ~~项目级测试后门 `NODE_ENV !== 'production'` → `=== 'test'` 的统一改造（`SmsAuthController`/`EmailAuthController`/`ws/handler`）。~~ **已由 plan Task 10 实施**（见 §10.C），不再是遗留项。

---

## 8. 验收标准

1. `npm test` 全绿（含 T1–T12 新增用例与既有用例）。
2. `npx tsc --noEmit` 无错误。
3. 代码审查可确认：登录路径对「账号不存在 / 未设密码 / 密码错误」三者执行等价成本的 scrypt。
4. `auth/AGENTS.md` 口径与实现一致。
5. 现有 401/429 口径与文案未变（除新增的注册频控 429 与超长密码 400）。

---

## 9. 回滚方案

各变更相互独立、粒度小，可按文件 `git revert`；无 schema 迁移、无新依赖、无配置项强制要求（`MEMORY_MAX_ENTRIES`/`REG_MAX` 等常量如需可后续外置为环境变量，本设计取硬编码常量）。

---

## 10. 实现后终审发现与修订决策（2026-09-27）

分支 `feat/auth-hardening`（`949f2f5..82888c3`，10 提交）7 个任务已按本 spec 完成并通过任务级审查；全分支终审（跨任务视角）另发现两个**本分支新引入**、任务级审查看不到的可用性问题（A、B）与一个 pre-existing 问题（C）。经用户决策：**A、B 在本分支内修复**（对应 plan Task 8 / Task 9），**C 登记为独立后续项，并已于同日作为独立变更实施**（见 §10.C）。

### A. 注册频控「进入即计数」→ 修订为「验证码通过后计数」（已实施，plan Task 8）

问题：`recordRegisterAttempt` 原位于 `isRegisterThrottled` 之后、验证码校验之前，且频控仅账号维度、无 IP 维度。任何人知道目标手机号，即可用 5 次弱密码/错验证码请求在 15 分钟内打满配额，使受害者**首次设密码**直接 429（攻击者无需持有该账号、无需承担短信成本，可每 15 分钟循环维持）。

**修订决策（用户选定 方案 a）**：`isRegisterThrottled` 检查位置不变（仍在入口，尽早拒绝、避免无谓开销），`recordRegisterAttempt` 后移到 `verifyCode` 通过之后。未通过验证码的尝试**不再占用配额**——这类请求本就没有通过身份证明，不能作为「注册接口被刷」的有效度量；持有效验证码的真实用户配额完全不受影响，成功注册后仍 `clearRegisterCount` 复位。

代价（显式记录）：无验证码的洪泛请求不再被该计数器拦截，防刷能力下移。本分支**不引入 IP 维度限流**（与用户已确认的「登录限流仅账号维度、移除回退」口径一致），IP/网关层限流登记为独立项。

### B. I1 恒定成本校验的同步 `scryptSync` → 异步 `crypto.scrypt` + 有界并发（已实施，plan Task 9）

问题：I1 使「未知账号登录」也执行一次**同步** `scryptSync`（实测约 52.8ms / 约 16MB/次），而登录限流只有账号维度——攻击者用随机合法手机号洪泛时每个账号计数恒为 1、永不触发 429，请求无界进入**阻塞主循环**（`scryptSync` 阻塞 + 无 IP 限流是根因；auth 路由经核查确无 IP/全局限流中间件）。

**修订决策（用户选定 方案 b）**：`passwordUtils` 中全部 scrypt 调用（`hashPassword` / `verifyPassword` / `verifyPasswordConstantTime`）改为线程池版 `crypto.scrypt`（异步），三个函数签名相应变为 `Promise<...>`，调用点（注册 `hash`、登录 `passOk`）加 `await`；并以模块级信号量把**在途** scrypt 限制在 `MAX_CONCURRENT_SCRYPT = 4`（对齐 libuv 默认线程池大小），超出部分**排队等待而非拒绝**。

- 事件循环不再被 scrypt 阻塞：洪泛退化为「请求排队」而非「进程失去响应」。
- `DUMMY_STORED`（模块加载期同步构造的 dummy 散列）随之不可行，改为模块级固定随机盐 `DUMMY_SALT`；scrypt 成本只取决于 N/r/p/keylen，等价成本不变（见 §4.1 修订注）。
- 未采纳 方案 a（补 IP 维度/全局限流）：与已确认的「仅账号维度」口径冲突，且属独立变更面。
- 未采纳「超限直接拒绝」：突发下会误伤真实登录，且相对排队无额外收益。
- 边界：信号量只限制**在途**数量，未限制等待队列长度（队列内存远小于阻塞主循环的风险）；本分支不做队列上限——如需可后续外置为配置项。

### C. 同款 fail-open 后门仍在其他三处（已实施，plan Task 10）

`SmsAuthController`、`EmailAuthController`、`ws/handler` 原为 `NODE_ENV !== 'production'`。生产 `NODE_ENV` 漏配时 `'123456'`（或 ws 的 `user_<openid>` 前缀）可直接登录取 token，属真实高危。

**实施决策（用户确认范围）**：机械收紧为 `NODE_ENV === 'test'`，共 4 个判定点 / 3 个文件：

- `SmsAuthController.verifyCode`（登录/绑定共用）
- `EmailAuthController.verifyCode`（邮箱登录/绑定共用）
- `EmailAuthController.bindWechat` 双身份内联判定（email|phone）
- `ws/handler.parseUserFromToken` 的 `user_<openid>` 本地联调前缀——**保留该分支，仅收紧门槛**（用户确认，不删除）

同步更新 `EmailService`/`SmsService` 中 `EMAIL_DEV_TEST_CODE`/`SMS_DEV_TEST_CODE` 的注释语义（「仅 test 环境放行」）。发送侧 dev 日志回显（`EmailService.ts:45/87`、`SmsService.ts:80` 的 `NODE_ENV !== 'production'`）**不是验证码后门，未改动**。

**回归安全**：各 spec 均以 `NODE_ENV=test` 运行（`before` 中 `||=` 设置），`'123456'` 仍放行 → 既有用例零回归。新增 4 条用例断言 `NODE_ENV=development` 时 `'123456'` / `user_<openid>` 被拒（`sms-auth`、`email-auth` 登录与 `bindWechat` 双身份、`ws/__tests__/handler.spec.ts`）。

**未做**（用户明确排除）：IP/网关层限流、M1（`redisIncr` 原子性）、M3–M7。

---

## 11. 后续项 M1 实施（2026-09-27，`redisIncr` 原子化）

### 11.1 问题

`redisIncr` 原实现为「先 `INCR`，再在 `count === 1` 时 `EXPIRE`」两条独立命令（见本 spec §3 第 54 行）。两条命令之间存在进程崩溃/被杀的窗口：一旦在 `INCR` 与 `EXPIRE` 之间中断，计数键已被创建但**无 TTL**，计数**永不过期** → 该账号被**永久 429**。防刷机制因此退化为自锁（fail-closed DoS），属真实可用性缺陷。

### 11.2 决策（用户确认）

- **范围**：仅实施 M1。
- **方案**：A —— 单条 Lua 脚本原子执行（不使用 `SET NX EX + INCR`、不使用会退化为滑动窗口的 `multi().incr().expire()`）。
- **M7 不实施**：`trust proxy` 默认 1 的影响面已收缩——IP 维度限流此前已移除，`req.ip` 现在仅用于日志（[PasswordAuthController.ts:200](file:///d:/aistock/aistock-app-api/src/modules/auth/PasswordAuthController.ts#L200) 传入 `PasswordAuthController.log`），伪造 IP 不再影响任何安全判定，仅影响日志精度。

### 11.3 设计

- 新增模块常量 `INCR_WITH_TTL_LUA`（脚本内 `KEYS[1]` = 计数键、`ARGV[1]` = 窗口秒）：

```lua
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
```

- 新增最小客户端接口 `ThrottleRedisClient`（仅 `eval`），使 Redis 集成边界可注入、可单测：

```ts
export interface ThrottleRedisClient {
    eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}
```

- `redisIncr` 改为单条 `eval`，客户端默认取单例 `redis`（调用方 `recordAttempt` 无需改动）：

```ts
export async function redisIncr(
    prefix: string,
    key: string,
    windowSec: number,
    client: ThrottleRedisClient = redis,
): Promise<void> {
    await client.eval(INCR_WITH_TTL_LUA, 1, prefix + key, windowSec);
}
```

- **语义保持不变**：仍为固定窗口（首个尝试设 TTL，后续 `INCR` 不刷新 TTL）；`FAIL_WINDOW_SEC` / `REG_WINDOW_SEC`、阈值 `FAIL_MAX` / `REG_MAX`、内存兜底与全部既有公开函数签名不变；对外状态码与文案不变。
- **健壮性提升**：单条脚本整体原子，不再存在「建键与设 TTL 之间中断」的窗口；`TTL < 0` 分支可自愈历史遗留的无 TTL 键。
- **零新增依赖**：使用 ioredis 原生 `eval`；不引入常驻定时器；不使用 `any`（外部值用 `unknown`）。

### 11.4 测试

- 新增单测：注入假客户端，断言 `redisIncr` 仅发出**一次** `eval`（`numkeys=1`、key 为 `prefix + account`、ARGV 为窗口秒、脚本含 `INCR`/`EXPIRE`）。
  - 假客户端只实现 `eval`（不提供 `incr`/`expire`）：若实现回退为两步，运行期即报错 → 回归守卫。
- 既有内存兜底用例（`redis.disconnect()`）不受影响。
- 门禁：`node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"` 全绿；`npx tsc --noEmit` 无错误；`npm test` 全库 `fail` 基线仍为 12。

### 11.5 影响面与回滚

- 影响文件：`src/modules/auth/loginThrottle.ts`、`src/modules/auth/__tests__/login-throttle.spec.ts`。
- 无 schema 迁移、无新依赖、无配置项；对外行为不变。
- 回滚：单文件 `git revert` 即可。

### 11.6 未做

M3–M7（其中 M3「成功登录不清 IP 计数」因 IP 维度限流移除而失效；M7 影响面仅余日志），IP/网关层限流。
