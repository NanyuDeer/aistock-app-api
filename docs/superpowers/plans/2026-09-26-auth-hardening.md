# 密码认证加固（I1–I4 + 文档口径修正）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收敛 `src/modules/auth` 的 4 项后端遗留问题（时间侧信道、内存兜底无界、密码长度无上限、注册无判重/无频控/测试后门过宽）与 1 处文档口径债务，对外状态码与文案除「注册超长密码 400」「注册频控 429」外保持不变。

**Architecture:** 分 7 个可独立评审的任务：I1 恒定成本校验（新增函数 + 调用点去短路）、I3 长度上限（常量 + 两入口）、I2 内存兜底清扫与容量上限、I4a 注册提前判重、I4b 独立注册频控、I4c 测试后门作用域收紧、D1 文档与修改记录。全部沿用现有「Redis 优先 + 内存 Map 兜底」结构与零依赖 scrypt，不新增依赖、不引入常驻定时器。

**Tech Stack:** Node.js + TypeScript（strict）、Express 5、`node:test` + `tsx`、PostgreSQL（`pg`）、ioredis（本地不可用时自动降级内存）。

**Spec:** `docs/superpowers/specs/2026-09-26-auth-hardening-design.md`

## Global Constraints

- 仓库：`d:\aistock\aistock-app-api`；分支 `feat/auth-hardening`（自 `master` 切出，本计划全程在此分支）。
- 环境：Windows + PowerShell；命令用 `;` 串联；类型检查 `npx tsc --noEmit`。
- **测试闸门**：每个 Task 以定向命令 `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"` 判定（本模块基线全绿）。全库 `npm test` 只用于核对「无新增失败」：**实测基线为 `ℹ tests 751 / pass 739 / fail 12`**（2026-09-27 在 `82888c3` 实测；`tests`/`pass` 会随新增用例数增加，判定口径为 **`fail` 恒为 12**），12 例失败分布在 ConceptIndustryMap、FeishuResearchReportService、MediaAttentionResonanceFix、StockConceptMappingService、StockInfoPushService、StockInfoService、StockMonitorService、StockResonanceService、internalRoutes、windLeadersAiPrompt、calendar.rhythm-calendar、prediction 等与本任务无关的模块（基线日志 `.superpowers/sdd/baseline-full-test.log`）；**不得**以「全仓全绿」作为通过条件。
- `changelog-pending.md` 被 `.gitignore:24` 忽略、不入库：仍按 aistock-workflow Phase 9 追加本地记录，但**禁止 `git add` 该文件**（对忽略路径执行 `git add` 会报错）；用户执行 "commit" 时由 `git-workflow` 读取并汇总进 `CHANGELOG.md`。
- 不改动既有 401/429 口径与文案；**仅允许新增**两条对外文案：注册超长密码 `400「密码长度不得超过 128 位」`、注册频控 `429「操作过于频繁，请稍后再试」`。
- `verifyPassword(password, stored)` 现有语义保持不变（`stored` 为空仍返回 `false`），恒定成本能力放在新函数中。
- 不新增 npm 依赖（继续零依赖 scrypt）；不引入 `setInterval` 等常驻定时器。
- 不为测试向生产代码添加 test-only 探针/方法。
- 新增代码禁止 `any`，外部值用 `unknown`；沿用文件现有 4 空格缩进与单引号风格。
- 每个 Task 的 commit 只提交该 Task 涉及的源码与测试文件；`changelog-pending.md` 在 Task 7 统一追加（用户执行 "commit" 时由 `git-workflow` 汇总进 `CHANGELOG.md`）。
- 只 `git add` 具体文件，禁止 `git add .`；commit message 用中文。
- 只更新已存在的文档文件（`src/modules/auth/AGENTS.md`、`changelog-pending.md`），不新建文档。

---

### Task 1: I1 — 恒定成本密码校验

**Files:**
- Modify: `src/modules/auth/passwordUtils.ts`（在 `verifyPassword` 之后、`isStrongPassword` 之前新增）
- Modify: `src/modules/auth/PasswordAuthController.ts:8`（import）、`src/modules/auth/PasswordAuthController.ts:187`（调用点）
- Test: `src/modules/auth/__tests__/password-utils.spec.ts`、`src/modules/auth/__tests__/password-auth.spec.ts`

**Interfaces:**
- Consumes: `hashPassword(password: string): string`、`verifyPassword(password: string, stored: string | null): boolean`（同文件已有）
- Produces: `verifyPasswordConstantTime(password: string, stored: string | null): boolean`（Task 2 及后续任务不再改动它）

- [ ] **Step 1: 写失败测试（单元）**

把 `src/modules/auth/__tests__/password-utils.spec.ts` 第 3 行的 import 改为（本步只加 `verifyPasswordConstantTime`；`MAX_PASSWORD_LENGTH` 在 Task 2 才会导出，到 Task 2 再补）：

```ts
import { hashPassword, verifyPassword, isStrongPassword, verifyPasswordConstantTime } from '../passwordUtils';
```

在文件末尾追加：

```ts
test('verifyPasswordConstantTime 结果与 verifyPassword 一致（null / 正确 / 错误）', () => {
    assert.equal(verifyPasswordConstantTime('abc12345', null), false);
    const stored = hashPassword('abc12345');
    assert.equal(verifyPasswordConstantTime('abc12345', stored), true);
    assert.equal(verifyPasswordConstantTime('abc12346', stored), false);
});

test('verifyPasswordConstantTime 对空 stored 仍执行 scrypt（耗时下界）', () => {
    const start = process.hrtime.bigint();
    assert.equal(verifyPasswordConstantTime('abc12345', null), false);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1000000;
    // N=16384 的单次 scrypt 为数十毫秒量级；纯比较路径仅零点几毫秒。
    // 取 1ms 作为保守下界，避免 CI 抖动造成 flaky。
    assert.ok(elapsedMs > 1, `期望 scrypt 级耗时，实际 ${elapsedMs.toFixed(3)}ms`);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/password-utils.spec.ts`

Expected: FAIL —— `TypeError: verifyPasswordConstantTime is not a function`（未导出时导入值为 `undefined`；若报「未提供该导出」属同类失败）

- [ ] **Step 3: 实现最小代码**

在 `src/modules/auth/passwordUtils.ts` 的 `verifyPassword` 函数体结束（第 59 行 `}`）与 `isStrongPassword`（第 61 行）之间插入：

```ts
// I1：恒定成本校验。
// verifyPassword 在 stored 为空时零成本返回 false，使「账号不存在 / 未设密码」与「密码错误」
// 在响应耗时上可区分，与「登录失败口径统一、不暴露账号存在性」的目标矛盾。
// 本函数对空 stored 也执行一次同参数 scrypt 以抹平耗时；verifyPassword 自身语义不变。
// dummy 散列在模块加载时构造一次（与用户密码同参数），避免每次请求重复构造。
const DUMMY_PARTS = hashPassword('__dummy__').split('$');

export function verifyPasswordConstantTime(password: string, stored: string | null): boolean {
    if (!stored) {
        // 对 dummy 散列执行等价成本 scrypt，结果丢弃，仅用于对齐耗时
        const dummySalt = Buffer.from(DUMMY_PARTS[4], 'base64');
        try {
            crypto.scryptSync(password, dummySalt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
        } catch {
            // 极端输入（如超长 password）导致 scrypt 抛错时同样按失败处理
        }
        return false;
    }
    return verifyPassword(password, stored);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test src/modules/auth/__tests__/password-utils.spec.ts`

Expected: PASS（原有 6 例 + 新增 2 例全绿；其中「verifyPassword 对 null / 非法格式返回 false」用例同时守住 `verifyPassword` 语义未变）

- [ ] **Step 5: 改调用点：去掉 `!!row` 短路**

`src/modules/auth/PasswordAuthController.ts` 第 8 行改为：

```ts
import { hashPassword, isStrongPassword, verifyPasswordConstantTime } from './passwordUtils';
```

第 187 行改为：

```ts
            // I1：保留 !!row 短路会让「账号不存在」路径零成本，形成时间侧信道；此处恒做等价成本校验
            const passOk = verifyPasswordConstantTime(password, row?.password_hash ?? null);
```

- [ ] **Step 6: 追加回归守卫测试（集成）**

在 `src/modules/auth/__tests__/password-auth.spec.ts` 末尾追加：

```ts
test('账号不存在时密码登录：401 统一文案（恒定成本路径不短路）', async () => {
    mockQuery(async () => ({ rows: [] }));
    const res = await call(buildApp(), 'POST', '/api/auth/password/login', { account: '13900000028', password: 'abc12345' }, { ip: '10.9.0.1' });
    assert.equal(res.status, 401);
    assert.equal(res.json?.message, '账号或密码错误');
});
```

> 该用例是回归守卫（改动前后都应为 401），**不**构成 I1 的 RED 证据。I1 调用点的最终判定依据为：Step 1 的耗时下界用例 + 代码审查确认已无 `!!row` 短路（见 spec §8.3）。

- [ ] **Step 7: 运行测试确认通过**

Run: `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"`

Expected: PASS（本模块既有用例 + 新增 2 例全绿，无失败）

- [ ] **Step 8: Commit**

```bash
git add src/modules/auth/passwordUtils.ts src/modules/auth/PasswordAuthController.ts src/modules/auth/__tests__/password-utils.spec.ts src/modules/auth/__tests__/password-auth.spec.ts
git commit -m "修复(auth): 密码登录对空密码散列执行等价成本校验，消除时间侧信道"
```

---

### Task 2: I3 — 密码长度上限 128

**Files:**
- Modify: `src/modules/auth/passwordUtils.ts`（新增常量 + `isStrongPassword` 加上限）
- Modify: `src/modules/auth/PasswordAuthController.ts`（注册文案细分；登录超长分支）
- Test: `src/modules/auth/__tests__/password-utils.spec.ts`、`src/modules/auth/__tests__/password-auth.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `verifyPasswordConstantTime`
- Produces: `MAX_PASSWORD_LENGTH = 128`（`number`，供控制器与测试引用）

- [ ] **Step 1: 写失败测试（单元）**

`src/modules/auth/__tests__/password-utils.spec.ts` 第 3 行 import 改为：

```ts
import { hashPassword, verifyPassword, isStrongPassword, verifyPasswordConstantTime, MAX_PASSWORD_LENGTH } from '../passwordUtils';
```

在文件末尾追加：

```ts
test('MAX_PASSWORD_LENGTH 为 128，isStrongPassword 接受 128 位并拒绝 129 位', () => {
    assert.equal(MAX_PASSWORD_LENGTH, 128);
    const ok = `a1${'x'.repeat(126)}`;
    const tooLong = `a1${'x'.repeat(127)}`;
    assert.equal(ok.length, 128);
    assert.equal(tooLong.length, 129);
    assert.equal(isStrongPassword(ok), true);
    assert.equal(isStrongPassword(tooLong), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/password-utils.spec.ts`

Expected: FAIL —— `AssertionError`（`MAX_PASSWORD_LENGTH` 为 `undefined`，首个断言 `undefined === 128` 不成立）

- [ ] **Step 3: 实现最小代码（工具层）**

`src/modules/auth/passwordUtils.ts` 第 61-64 行的 `isStrongPassword` 整体替换为：

```ts
// I3：密码长度上限，阻断超长输入进入 scryptSync 造成 CPU/内存放大（128 位足以覆盖任何正常口令）
export const MAX_PASSWORD_LENGTH = 128;

export function isStrongPassword(password: string): boolean {
    if (typeof password !== 'string' || password.length < 8) return false;
    if (password.length > MAX_PASSWORD_LENGTH) return false;
    return /[A-Za-z]/.test(password) && /\d/.test(password);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test src/modules/auth/__tests__/password-utils.spec.ts`

Expected: PASS（8 例全绿）

- [ ] **Step 5: 写失败测试（集成：注册超长 400、登录超长 401 且不查库）**

在 `src/modules/auth/__tests__/password-auth.spec.ts` 末尾追加：

```ts
test('注册超长密码：400 且文案为长度超限', async () => {
    mockQuery(async () => ({ rows: [] }));
    const longPassword = `a1${'x'.repeat(127)}`;
    const res = await call(buildApp(), 'POST', '/api/auth/register', { account: '13900000022', password: longPassword, code: '123456' }, { ip: '10.5.0.1' });
    assert.equal(res.status, 400);
    assert.equal(res.json?.message, '密码长度不得超过 128 位');
});

test('登录超长密码：401 统一文案，且不查询数据库', async () => {
    const account = '13900000023';
    let selectCount = 0;
    mockQuery(async (sql) => {
        if (sql.includes('SELECT')) {
            selectCount += 1;
            return { rows: [{ id: 'u11', openid: null, phone: account, email: null, nickname: null, avatar_url: null, password_hash: hashPassword('abc12345') }] };
        }
        return { rows: [] };
    });
    const longPassword = `a1${'x'.repeat(127)}`;
    const res = await call(buildApp(), 'POST', '/api/auth/password/login', { account, password: longPassword }, { ip: '10.5.0.2' });
    assert.equal(res.status, 401);
    assert.equal(res.json?.message, '账号或密码错误');
    assert.equal(selectCount, 0);
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/password-auth.spec.ts`

Expected: FAIL —— 首个新用例 `400` 通过但文案为 `密码至少 8 位且需包含字母和数字`（`AssertionError`）；第二个新用例 `selectCount === 1` 使 `assert.equal(selectCount, 0)` 失败

- [ ] **Step 7: 实现最小代码（控制器两入口）**

`src/modules/auth/PasswordAuthController.ts` 第 8 行 import 改为：

```ts
import { hashPassword, isStrongPassword, MAX_PASSWORD_LENGTH, verifyPasswordConstantTime } from './passwordUtils';
```

注册分支（第 81-84 行）替换为：

```ts
            if (typeof password !== 'string' || !isStrongPassword(password)) {
                // 超长属新增约束，单独给出可诊断文案；其余沿用原文案
                const tooLong = typeof password === 'string' && password.length > MAX_PASSWORD_LENGTH;
                createResponse(res, 400, tooLong ? '密码长度不得超过 128 位' : '密码至少 8 位且需包含字母和数字');
                return;
            }
```

`passwordLogin` 中，在防刷块结束（第 165 行 `}`）与 `let row: UserRow | undefined;`（第 167 行）之间插入：

```ts
            // I3：超长密码在进入 scrypt 之前按失败处理（不新增对外码，避免区分出「长度非法」信号，也不做 DB 查询）
            if (password.length > MAX_PASSWORD_LENGTH) {
                await recordFailure(identity.value);
                PasswordAuthController.log('login', '❌ 登录失败（密码超长）', { account: identity.value, ip, len: password.length });
                createResponse(res, 401, '账号或密码错误');
                return;
            }

```

- [ ] **Step 8: 运行测试确认通过**

Run: `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"`

Expected: PASS（`password-utils.spec.ts` 8 例、`password-auth.spec.ts` 12 例全绿，其余本模块用例不受影响）

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth/passwordUtils.ts src/modules/auth/PasswordAuthController.ts src/modules/auth/__tests__/password-utils.spec.ts src/modules/auth/__tests__/password-auth.spec.ts
git commit -m "修复(auth): 新增密码长度上限 128，阻断超长输入进入 scrypt"
```

---

### Task 3: I2 — 内存兜底 Map 的过期清理与容量上限

**Files:**
- Modify: `src/modules/auth/loginThrottle.ts`
- Test: `src/modules/auth/__tests__/login-throttle.spec.ts`

**Interfaces:**
- Consumes: 现有 `memoryFail` / `memoryGet` / `redisIncr`（模块内私有）
- Produces: `MEMORY_MAX_ENTRIES = 10000`（`number`）；`memoryFail` 在超过上限后按「删过期 → 最旧 `expireAt` 先淘汰」收敛到上限

- [ ] **Step 1: 写失败测试（行为断言）**

`src/modules/auth/__tests__/login-throttle.spec.ts` 第 1-3 行 import 改为：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import redis from '../../../core/redis';
import { isThrottled, recordFailure, clearAccountFailure, FAIL_MAX, MEMORY_MAX_ENTRIES } from '../loginThrottle';
```

在 `uniquePhone` 之后追加灌入用账号生成器（连续序号，保证互不相同，避免生日碰撞导致容量未超上限）：

```ts
// 灌入用账号：连续序号保证互不相同（139/138 前缀与 uniquePhone 区分开）
function floodPhone(base: number, i: number): string {
    return `138${String(base + i).padStart(8, '0')}`;
}
```

在文件末尾追加：

```ts
test('内存兜底超容量时按最旧 expireAt 淘汰', async () => {
    // 本用例断言内存兜底语义：显式断开 Redis，避免本机存在 Redis 时走 Redis 分支使断言失效
    redis.disconnect();

    const oldest = uniquePhone();
    for (let i = 0; i < FAIL_MAX; i += 1) {
        await recordFailure(oldest);
    }
    assert.equal(await isThrottled(oldest), true);

    const base = 10000000;
    for (let i = 0; i < MEMORY_MAX_ENTRIES; i += 1) {
        await recordFailure(floodPhone(base, i));
    }

    // 注：过期清理分支（entry.expireAt <= now）由本用例触发的同一次清扫逻辑覆盖；
    // expireAt 为 Date.now()+窗口 且不可注入，故不强行断言过期，仅断言容量淘汰路径。
    assert.equal(await isThrottled(oldest), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/login-throttle.spec.ts`

Expected: FAIL —— 首个断言 `assert.equal(MEMORY_MAX_ENTRIES, 10000)` 失败（`undefined`）；即便跳过该断言，末行 `isThrottled(oldest)` 也会因无容量淘汰而为 `true`

- [ ] **Step 3: 实现最小代码**

`src/modules/auth/loginThrottle.ts` 第 27-38 行（`const memoryFail = ...` 与 `memoryIncr`）整体替换为：

```ts
// 内存兜底 Map 的容量上限（I2）：随机账号洪泛时条目无界增长会持续占用内存
export const MEMORY_MAX_ENTRIES = 10000;

const memoryFail = new Map<string, { count: number; expireAt: number }>();

// 惰性清扫：仅当条目数超过上限时执行（摊薄成本，且不引入常驻 setInterval 定时器）
function sweepMemory(now: number): void {
    for (const [key, entry] of memoryFail) {
        if (entry.expireAt <= now) memoryFail.delete(key);
    }
    if (memoryFail.size <= MEMORY_MAX_ENTRIES) return;
    // 仍超上限：按 expireAt 升序（最旧先淘汰）删除至上限
    const overflow = memoryFail.size - MEMORY_MAX_ENTRIES;
    const ordered = [...memoryFail.entries()].sort((a, b) => a[1].expireAt - b[1].expireAt);
    for (let i = 0; i < overflow; i += 1) {
        memoryFail.delete(ordered[i][0]);
    }
}

function memoryIncr(prefix: string, key: string): void {
    const now = Date.now();
    const mapKey = prefix + key;
    const entry = memoryFail.get(mapKey);
    if (!entry || entry.expireAt <= now) {
        memoryFail.set(mapKey, { count: 1, expireAt: now + FAIL_WINDOW_SEC * 1000 });
    } else {
        entry.count += 1;
    }
    if (memoryFail.size > MEMORY_MAX_ENTRIES) sweepMemory(now);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test src/modules/auth/__tests__/login-throttle.spec.ts`

Expected: PASS（原有 3 例 + 新增 1 例全绿）

> 淘汰确定性说明：`oldest` 先插入，其 `expireAt` 不晚于任何灌入条目；即使与灌入条目同毫秒（值相等），V8 `sort` 稳定排序会保留插入顺序，`oldest` 仍排在并列最小值之首，故必被淘汰。

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/loginThrottle.ts src/modules/auth/__tests__/login-throttle.spec.ts
git commit -m "修复(auth): 登录失败内存兜底增加过期清理与容量上限"
```

---

### Task 4: I4a — 注册提前判重（避免无用 scrypt）

**Files:**
- Modify: `src/modules/auth/PasswordAuthController.ts`（`register`：验证码校验之后、`hashPassword` 之前）
- Test: `src/modules/auth/__tests__/password-auth.spec.ts`

**Interfaces:**
- Consumes: 现有 `pool.query`、`createResponse`
- Produces: 无新导出（仅注册路径内部行为）

- [ ] **Step 1: 写失败测试**

在 `src/modules/auth/__tests__/password-auth.spec.ts` 末尾追加：

```ts
test('注册已设密码账号：提前判重返回 409 且不执行 upsert', async () => {
    const account = '13900000024';
    let insertCount = 0;
    mockQuery(async (sql) => {
        if (sql.includes('SELECT password_hash')) {
            return { rows: [{ password_hash: 'scrypt$16384$8$1$AA==$BB==' }] };
        }
        if (sql.includes('INSERT INTO users')) {
            insertCount += 1;
            return { rows: [] };
        }
        return { rows: [] };
    });
    const res = await call(buildApp(), 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip: '10.6.0.1' });
    assert.equal(res.status, 409);
    assert.equal(res.json?.message, '该账号已设置密码');
    assert.equal(insertCount, 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/password-auth.spec.ts`

Expected: FAIL —— 状态码与文案已为 409/「该账号已设置密码」，但 `insertCount` 为 `1`（仍走了 upsert），`assert.equal(insertCount, 0)` 失败

- [ ] **Step 3: 实现最小代码**

`src/modules/auth/PasswordAuthController.ts` 中，在验证码校验块结束（第 93 行 `}`）与 `const hash = hashPassword(password);`（第 95 行）之间插入：

```ts
            // I4a：提前判重，避免对已设密码账号白跑一次昂贵 scrypt。
            // 原子 upsert 仍是最终仲裁（并发漏网由 0 行 → 409 兜底）；判重查询失败不阻断主流程。
            try {
                const existing =
                    identity.kind === 'phone'
                        ? await pool.query(`SELECT password_hash FROM users WHERE phone = $1`, [identity.value])
                        : await pool.query(`SELECT password_hash FROM users WHERE email = $1`, [identity.value]);
                const existingHash = (existing.rows[0] as { password_hash?: string | null } | undefined)?.password_hash;
                if (existingHash) {
                    createResponse(res, 409, '该账号已设置密码');
                    return;
                }
            } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                PasswordAuthController.log('register', '⚠️ 提前判重失败，降级直接 upsert', { account: identity.value, error: errMsg });
            }

```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"`

Expected: PASS（含既有「注册已设密码账号：409」用例——其 mock 对判重 SELECT 返回空行，落到 upsert 后 0 行 → 409，行为不变）

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/PasswordAuthController.ts src/modules/auth/__tests__/password-auth.spec.ts
git commit -m "优化(auth): 注册提前判重，已设密码账号不再白跑 scrypt"
```

---

### Task 5: I4b — 独立注册频控

**Files:**
- Modify: `src/modules/auth/loginThrottle.ts`（TTL 参数化 + 三个注册计数函数）
- Modify: `src/modules/auth/PasswordAuthController.ts`（`register` 接入频控与复位）
- Test: `src/modules/auth/__tests__/login-throttle.spec.ts`、`src/modules/auth/__tests__/password-auth.spec.ts`

**Interfaces:**
- Consumes: Task 3 的 `MEMORY_MAX_ENTRIES` / `sweepMemory` / `memoryIncr` / `memoryGet` / `redisIncr`
- Produces:
  - `REG_WINDOW_SEC = 900`（`number`）、`REG_MAX = 5`（`number`）
  - `isRegisterThrottled(account: string): Promise<boolean>`
  - `recordRegisterAttempt(account: string): Promise<void>`
  - `clearRegisterCount(account: string): Promise<void>`

- [ ] **Step 1: 写失败测试（单元：计数隔离）**

`src/modules/auth/__tests__/login-throttle.spec.ts` 的 loginThrottle import 改为：

```ts
import { isThrottled, recordFailure, clearAccountFailure, FAIL_MAX, MEMORY_MAX_ENTRIES, REG_MAX, isRegisterThrottled, recordRegisterAttempt, clearRegisterCount } from '../loginThrottle';
```

在文件末尾追加：

```ts
test('注册计数与登录失败计数相互隔离', async () => {
    // 断言内存兜底语义：显式断开 Redis，避免本机存在 Redis 时走 Redis 分支使断言失效
    redis.disconnect();

    const acct = uniquePhone();
    assert.equal(REG_MAX, 5);
    for (let i = 0; i < REG_MAX; i += 1) {
        await recordRegisterAttempt(acct);
    }
    assert.equal(await isRegisterThrottled(acct), true);
    // 注册计数不得污染登录失败计数（否则首次设密码被误锁将无法登录）
    assert.equal(await isThrottled(acct), false);
    await clearRegisterCount(acct);
    assert.equal(await isRegisterThrottled(acct), false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/login-throttle.spec.ts`

Expected: FAIL —— `TypeError: recordRegisterAttempt is not a function`（或 `REG_MAX` 为 `undefined`）

- [ ] **Step 3: 实现最小代码（计数层：TTL 参数化 + 注册计数）**

`src/modules/auth/loginThrottle.ts` 中，把 `redisIncr` 改为带窗口参数：

```ts
async function redisIncr(prefix: string, key: string, windowSec: number): Promise<void> {
    const fullKey = prefix + key;
    const count = await redis.incr(fullKey);
    if (count === 1) await redis.expire(fullKey, windowSec);
}
```

把 `memoryIncr` 改为带窗口参数：

```ts
function memoryIncr(prefix: string, key: string, windowSec: number): void {
    const now = Date.now();
    const mapKey = prefix + key;
    const entry = memoryFail.get(mapKey);
    if (!entry || entry.expireAt <= now) {
        memoryFail.set(mapKey, { count: 1, expireAt: now + windowSec * 1000 });
    } else {
        entry.count += 1;
    }
    if (memoryFail.size > MEMORY_MAX_ENTRIES) sweepMemory(now);
}
```

`recordFailure` 的两个调用点补上窗口参数：

```ts
export async function recordFailure(account: string): Promise<void> {
    memoryIncr(ACCT_PREFIX, account, FAIL_WINDOW_SEC);
    if (redisAvailable) {
        try {
            await redisIncr(ACCT_PREFIX, account, FAIL_WINDOW_SEC);
        } catch {
            redisAvailable = false;
        }
    }
}
```

在文件末尾追加注册频控区块：

```ts
// 注册频控（I4b）：独立账号维度计数，与登录失败计数完全隔离，避免首次设密码被误锁导致无法登录。
// 口径：进入处理即计数（防刷注册接口本身），成功注册后复位。
export const REG_WINDOW_SEC = 900;
export const REG_MAX = 5;

const REG_PREFIX = 'auth:reg:acct:';

export async function isRegisterThrottled(account: string): Promise<boolean> {
    if (redisAvailable) {
        try {
            const raw = await redis.get(REG_PREFIX + account);
            const count = parseInt(raw ?? '0', 10) || 0;
            return count >= REG_MAX;
        } catch {
            redisAvailable = false;
        }
    }
    return memoryGet(REG_PREFIX, account) >= REG_MAX;
}

export async function recordRegisterAttempt(account: string): Promise<void> {
    memoryIncr(REG_PREFIX, account, REG_WINDOW_SEC);
    if (redisAvailable) {
        try {
            await redisIncr(REG_PREFIX, account, REG_WINDOW_SEC);
        } catch {
            redisAvailable = false;
        }
    }
}

export async function clearRegisterCount(account: string): Promise<void> {
    memoryFail.delete(REG_PREFIX + account);
    if (redisAvailable) {
        try {
            await redis.del(REG_PREFIX + account);
        } catch {
            redisAvailable = false;
        }
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test src/modules/auth/__tests__/login-throttle.spec.ts`

Expected: PASS（原有 3 例 + Task 3 的 1 例 + 本任务 1 例全绿）

- [ ] **Step 5: 写失败测试（集成：429 与复位）**

在 `src/modules/auth/__tests__/password-auth.spec.ts` 末尾追加：

```ts
test('注册频控：同账号尝试超过 REG_MAX 返回 429', async () => {
    const account = '13900000025';
    const ip = '10.7.0.1';
    mockQuery(async (sql) => {
        if (sql.includes('SELECT password_hash')) return { rows: [] };
        if (sql.includes('INSERT INTO users')) {
            return { rows: [{ id: 'u12', openid: null, phone: account, email: null, nickname: null, avatar_url: null }] };
        }
        return { rows: [] };
    });
    const app = buildApp();
    for (let i = 0; i < REG_MAX; i += 1) {
        // 验证码错误 → 400，但已计入注册尝试
        const r = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '000000' }, { ip });
        assert.equal(r.status, 400);
    }
    const blocked = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json?.message, '操作过于频繁，请稍后再试');
});

test('注册成功复位注册计数', async () => {
    const account = '13900000026';
    const ip = '10.7.0.2';
    mockQuery(async (sql) => {
        if (sql.includes('SELECT password_hash')) return { rows: [] };
        if (sql.includes('INSERT INTO users')) {
            return { rows: [{ id: 'u13', openid: null, phone: account, email: null, nickname: null, avatar_url: null }] };
        }
        return { rows: [] };
    });
    const app = buildApp();
    for (let i = 0; i < 3; i += 1) {
        const r = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '000000' }, { ip });
        assert.equal(r.status, 400);
    }
    const ok = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip });
    assert.equal(ok.status, 200);
    // 若未复位，累计已达 4 次，本轮第 2 次即会 429；复位后 4 次尝试应全为 400
    for (let i = 0; i < 4; i += 1) {
        const r = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '000000' }, { ip });
        assert.equal(r.status, 400);
    }
});
```

同时把该文件第 11 行的 import 改为：

```ts
import { FAIL_MAX, REG_MAX } from '../loginThrottle';
```

- [ ] **Step 6: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/password-auth.spec.ts`

Expected: FAIL —— 第 6 次注册请求实际返回 400（未接入频控），`assert.equal(blocked.status, 429)` 失败

- [ ] **Step 7: 接入调用点**

`src/modules/auth/PasswordAuthController.ts` 第 9 行 import 改为：

```ts
import {
    clearAccountFailure,
    clearRegisterCount,
    isRegisterThrottled,
    isThrottled,
    recordFailure,
    recordRegisterAttempt,
} from './loginThrottle';
```

在 `register` 的 `if (!identity) { ... return; }` 块之后插入：

```ts
            // I4b：注册独立频控（账号维度，与登录失败计数隔离）；进入处理即计数，成功注册后复位
            if (await isRegisterThrottled(identity.value)) {
                PasswordAuthController.log('register', '⛔ 触发注册频控', { account: identity.value });
                createResponse(res, 429, '操作过于频繁，请稍后再试');
                return;
            }
            await recordRegisterAttempt(identity.value);
```

在 upsert 成功赋值 `row = result.rows[0] as UserRow;`（第 121 行）之后、`const token = ...` 之前插入：

```ts
            await clearRegisterCount(identity.value);
```

- [ ] **Step 8: 运行测试确认通过**

Run: `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"`

Expected: PASS（本模块全部用例全绿，含新增 2 例注册频控用例）

- [ ] **Step 9: Commit**

```bash
git add src/modules/auth/loginThrottle.ts src/modules/auth/PasswordAuthController.ts src/modules/auth/__tests__/login-throttle.spec.ts src/modules/auth/__tests__/password-auth.spec.ts
git commit -m "新增(auth): 注册独立账号维度频控（900s/5 次，超限 429）"
```

---

### Task 6: I4c — 收紧注册/登录验证码测试后门作用域

**Files:**
- Modify: `src/modules/auth/PasswordAuthController.ts`（`verifyCode`）
- Test: `src/modules/auth/__tests__/password-auth.spec.ts`

**Interfaces:**
- Consumes: `SMS_DEV_TEST_CODE`、`EMAIL_DEV_TEST_CODE`、`consumeCode`
- Produces: 无新导出（`verifyCode` 为私有静态方法，行为变更：万能码仅 `NODE_ENV === 'test'` 生效）

- [ ] **Step 1: 写失败测试**

在 `src/modules/auth/__tests__/password-auth.spec.ts` 末尾追加：

```ts
test('注册验证码后门仅在 NODE_ENV=test 生效', async () => {
    const prev = process.env.NODE_ENV;
    const account = '13900000027';
    mockQuery(async (sql) => {
        if (sql.includes('SELECT password_hash')) return { rows: [] };
        if (sql.includes('INSERT INTO users')) {
            return { rows: [{ id: 'u14', openid: null, phone: account, email: null, nickname: null, avatar_url: null }] };
        }
        return { rows: [] };
    });
    try {
        process.env.NODE_ENV = 'development';
        const res = await call(buildApp(), 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip: '10.10.0.1' });
        assert.equal(res.status, 400);
        assert.equal(res.json?.message, '验证码错误或已过期');
    } finally {
        process.env.NODE_ENV = prev;
    }
});
```

> 该用例必须在文件末尾：`before()` 只做一次 `NODE_ENV ||= 'test'`，测试内需自行设置并还原 `NODE_ENV`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/password-auth.spec.ts`

Expected: FAIL —— `NODE_ENV=development` 时万能码 `'123456'` 仍命中（`isDev` 为 true），实际返回 200，`assert.equal(res.status, 400)` 失败

- [ ] **Step 3: 实现最小代码**

`src/modules/auth/PasswordAuthController.ts` 第 54-59 行的 `verifyCode` 替换为：

```ts
    private static async verifyCode(identity: Identity, code: string): Promise<boolean> {
        // I4c：测试后门收紧为仅 NODE_ENV=test 生效
        // （此前 !== 'production' 时，staging 或容器漏配 NODE_ENV 的环境也会放行万能码，属真实风险）
        const isTest = process.env.NODE_ENV === 'test';
        const devCode = identity.kind === 'phone' ? SMS_DEV_TEST_CODE : EMAIL_DEV_TEST_CODE;
        if (isTest && code === devCode) return true;
        return consumeCode(identity.value, code);
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"`

Expected: PASS（测试与 CI 显式 `NODE_ENV=test`，既有走万能码的用例不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/PasswordAuthController.ts src/modules/auth/__tests__/password-auth.spec.ts
git commit -m "修复(auth): 密码注册/登录验证码后门收紧为仅 NODE_ENV=test 生效"
```

---

### Task 7: D1 — 模块文档口径修正 + 修改记录

**Files:**
- Modify: `src/modules/auth/AGENTS.md:22`、`src/modules/auth/AGENTS.md:41`
- Modify: `changelog-pending.md`

**Interfaces:**
- Consumes: 无
- Produces: 无（纯文档）

- [ ] **Step 1: 修正 AGENTS.md 两处口径**

`src/modules/auth/AGENTS.md` 第 22 行：

```markdown
- `POST /api/auth/password/login` — 密码登录（仅同账号维度防刷，15 分钟内失败达阈值返回 429，不降级验证码）
```

`src/modules/auth/AGENTS.md` 第 41 行：

```markdown
- `loginThrottle.ts` — 登录失败计数（仅账号维度，Redis 优先 + 内存兜底）
```

- [ ] **Step 2: 校验文档已更新且无残留旧口径**

Run: `Select-String -Path src\modules\auth\AGENTS.md -Pattern '同 IP|改用验证码登录'`

Expected: 无输出（退出码 1）——旧口径「同账号/同 IP」「提示改用验证码登录」已清除

- [ ] **Step 3: 追加修改记录**

将 `changelog-pending.md` 唯一一行 `（暂无待提交的修改）` 替换为：

```markdown
## [master] 2026-09-26 — 密码认证加固（I1–I4 + 文档口径修正）

### 修复

- **I1 时间侧信道**：`passwordUtils` 新增 `verifyPasswordConstantTime`，空密码散列（账号不存在 / 未设密码）也执行等价成本 scrypt；`PasswordAuthController.passwordLogin` 去掉 `!!row` 短路。
- **I2 内存兜底无界**：`loginThrottle` 内存 Map 增加惰性清扫（删除过期）与容量上限 `MEMORY_MAX_ENTRIES = 10000`（超限按最旧 `expireAt` 淘汰），不引入常驻定时器。
- **I3 密码长度无上限**：新增 `MAX_PASSWORD_LENGTH = 128`；注册超长返回 400「密码长度不得超过 128 位」，登录超长按统一失败口径 401 处理（不暴露长度信号，且不查库）。
- **I4a 无用 scrypt**：注册在验证码校验后、`hashPassword` 前提前 `SELECT password_hash` 判重，已设密码直接 409；原子 upsert 仍为最终仲裁。
- **I4b 注册无频控**：新增独立注册账号维度频控（`REG_WINDOW_SEC = 900`、`REG_MAX = 5`），超限 429「操作过于频繁，请稍后再试」，成功注册后复位，与登录失败计数隔离。
- **I4c 测试后门过宽**：`PasswordAuthController.verifyCode` 的万能码判定由 `NODE_ENV !== 'production'` 收紧为 `=== 'test'`。

### 文档

- `src/modules/auth/AGENTS.md`：修正密码登录与 `loginThrottle` 口径（删除「同 IP」「降级验证码登录」描述）。

### 测试

- 新增 I1 恒定成本（含耗时下界）、I2 容量淘汰、I3 长度上限、I4a 提前判重、I4b 注册频控与复位、I4c 后门作用域用例；定向 auth 用例与 `npx tsc --noEmit` 全绿，全库 `npm test` 无新增失败（基线 12 例既有失败）。
```

- [ ] **Step 4: 最终验证**

Run: `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"; npx tsc --noEmit; npm test 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail)'`

Expected:
- 定向 auth 用例全绿；
- `tsc` 无输出、退出码 0；
- `npm test` 汇总为 `ℹ tests 739`、`ℹ pass 727`、`ℹ fail 12`——即**与基线完全一致、无新增失败**。失败数高于 12 即本计划引入的回归，必须修复。

- [ ] **Step 5: Commit（`changelog-pending.md` 不入库）**

```bash
git add src/modules/auth/AGENTS.md
git commit -m "文档(auth): 修正密码登录与防刷口径描述"
```

Expected: 提交仅含 `src/modules/auth/AGENTS.md`。`changelog-pending.md` 被 `.gitignore:24` 忽略，**不要 `git add` 它**（对忽略路径执行 `git add` 会报错）；它作为本地修改记录，由用户执行 "commit" 时经 `git-workflow` 汇总进 `CHANGELOG.md`。

---

## 追加任务（2026-09-27）— 全分支终审发现 A / B 的修订

> 来源：spec §10（A = 注册频控计数后移；B = scrypt 异步化 + 有界并发）。A/B 均在本分支内实施；C（Sms/Email/ws 三处 fail-open 后门）**不在本次范围**。
> 两个任务沿用本计划全部 Global Constraints；此外：本批任务**不得**引入 IP 维度限流（维持「仅账号维度」口径），**不得**新增依赖（继续用 Node 内置 `crypto`），**不得**引入常驻定时器。

---

### Task 8: A — 注册频控计数后移到验证码通过之后

**Files:**
- Modify: `src/modules/auth/PasswordAuthController.ts`（`register`：`recordRegisterAttempt` 调用位置）
- Modify: `src/modules/auth/loginThrottle.ts`（`recordRegisterAttempt` 口径注释）
- Modify: `src/modules/auth/AGENTS.md`（注册接口与 `loginThrottle.ts` 口径）
- Modify: `changelog-pending.md`（追加，仅本地、不入库）
- Test: `src/modules/auth/__tests__/password-auth.spec.ts`

**Interfaces:**
- Consumes: `isRegisterThrottled` / `recordRegisterAttempt` / `clearRegisterCount`（签名、常量、前缀均不变）
- Produces: 无新导出。**行为变更**：注册频控只统计「验证码校验通过」的尝试；未通过验证码的请求不再占用配额（spec §10 A）

- [ ] **Step 1: 写失败测试（新用例）**

在 `src/modules/auth/__tests__/password-auth.spec.ts` 中，把既有 `test('注册频控：同账号尝试超过 REG_MAX 返回 429', ...)` 整体替换为下面两个用例（新语义 + 配额不被未认证请求消耗）：

```ts
test('注册频控不计未通过验证码的尝试：错误验证码不消耗配额', async () => {
    const account = uniqueRegAccount();
    const ip = '10.8.0.1';
    mockQuery(async (sql) => {
        if (sql.includes('SELECT password_hash')) return { rows: [] };
        if (sql.includes('INSERT INTO users')) {
            return { rows: [{ id: 'u15', openid: null, phone: account, email: null, nickname: null, avatar_url: null }] };
        }
        return { rows: [] };
    });
    const app = buildApp();
    // 错误验证码 → 400；这些尝试未经身份证明，不应占用注册频控配额
    for (let i = 0; i < REG_MAX + 2; i += 1) {
        const r = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '000000' }, { ip });
        assert.equal(r.status, 400);
    }
    // 配额未被消耗：随后一次合法注册应成功（而非 429）
    const ok = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip });
    assert.equal(ok.status, 200);
});

test('注册频控：验证码通过后的尝试超过 REG_MAX 返回 429', async () => {
    const account = uniqueRegAccount();
    const ip = '10.7.0.1';
    // 验证码通过（NODE_ENV=test 后门）但账号已设密码 → 409，属「已通过验证码的尝试」，计入配额
    mockQuery(async (sql) => {
        if (sql.includes('SELECT password_hash')) return { rows: [{ password_hash: 'scrypt$16384$8$1$AA==$BB==' }] };
        return { rows: [] };
    });
    const app = buildApp();
    for (let i = 0; i < REG_MAX; i += 1) {
        const r = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip });
        assert.equal(r.status, 409);
    }
    const blocked = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json?.message, '操作过于频繁，请稍后再试');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/password-auth.spec.ts`

Expected: FAIL —— 首个用例在第 6 次错误验证码请求处得到 429（`assert.equal(r.status, 400)` 失败）：现状「进入即计数」会把未通过验证码的尝试也计入配额。

- [ ] **Step 3: 实现最小代码（把计数后移）**

`src/modules/auth/PasswordAuthController.ts` 的 `register` 中，**删除**紧跟在 `isRegisterThrottled` 块之后的那一行：

```ts
            await recordRegisterAttempt(identity.value);
```

并把注释「// I4b：注册独立频控（账号维度，与登录失败计数隔离）；进入处理即计数，成功注册后复位」改为：

```ts
            // I4b：注册独立频控（账号维度，与登录失败计数隔离）；成功注册后复位。
            // A 修订（spec §10 A）：计数后移到 verifyCode 通过之后——未通过验证码的尝试不占配额，
            // 避免任意人用错验证码请求把目标账号配额打满，导致其无法首次设密码。
```

然后在验证码校验块之后（`if (!codeOk) { ... return; }` 之后、I4a 提前判重块之前）插入：

```ts
            // A：仅已通过验证码的尝试计入注册频控配额
            await recordRegisterAttempt(identity.value);
```

- [ ] **Step 4: 改写既有「复位」用例（保持覆盖，适配新语义）**

把 `test('注册成功复位注册计数', ...)` 整体替换为：

```ts
test('注册成功复位注册计数', async () => {
    const account = uniqueRegAccount();
    const ip = '10.7.0.2';
    let succeed = false;
    mockQuery(async (sql) => {
        if (sql.includes('SELECT password_hash')) return { rows: [] };
        if (sql.includes('INSERT INTO users')) {
            return succeed
                ? { rows: [{ id: 'u13', openid: null, phone: account, email: null, nickname: null, avatar_url: null }] }
                : { rows: [] };
        }
        return { rows: [] };
    });
    const app = buildApp();
    // 三次「验证码通过但 upsert 0 行」→ 409，累计 3 次已认证尝试
    for (let i = 0; i < 3; i += 1) {
        const r = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip });
        assert.equal(r.status, 409);
    }
    succeed = true;
    const ok = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip });
    assert.equal(ok.status, 200);
    succeed = false;
    // 若未复位，累计已达 4 次，本轮第 2 次即会 429；复位后 4 次尝试应全为 409
    for (let i = 0; i < 4; i += 1) {
        const r = await call(app, 'POST', '/api/auth/register', { account, password: 'abc12345', code: '123456' }, { ip });
        assert.equal(r.status, 409);
    }
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"`

Expected: PASS（本模块全部用例全绿；注册相关用例均已适配「验证码通过后计数」语义）

- [ ] **Step 6: 更新口径注释与文档**

`src/modules/auth/loginThrottle.ts` 中注册频控区块的口径注释改为：

```ts
// 注册频控（I4b）：独立账号维度计数，与登录失败计数完全隔离，避免首次设密码被误锁导致无法登录。
// 口径：验证码校验通过后才计数（仅已通过身份证明的尝试占用配额；否则任意人可用错验证码请求
// 把他人账号的配额打满，使其无法首次设密码），成功注册后复位。
```

`src/modules/auth/AGENTS.md` 第 21 行改为：

```markdown
- `POST /api/auth/register` — 密码注册（注册即登录；账号已设密码时 409；验证码通过后计入注册频控，900s 内 5 次上限，超限 429）
```

`src/modules/auth/AGENTS.md` 第 41 行改为：

```markdown
- `loginThrottle.ts` — 登录失败计数与注册频控（均仅账号维度，Redis 优先 + 内存兜底）
```

- [ ] **Step 7: 类型检查与全库基线核对**

Run: `npx tsc --noEmit; npm test 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail)'`

Expected: `tsc` 无输出、退出码 0；`npm test` 汇总为 `ℹ tests 752`、`ℹ pass 740`、`ℹ fail 12`（本任务净新增 1 用例；**`fail` 必须仍为 12**，高于 12 即回归）

- [ ] **Step 8: 追加修改记录（仅本地，不入库）**

在 `changelog-pending.md` **文件顶部**追加：

```markdown
## 2026-09-27 修复(auth): 注册频控计数后移到验证码通过之后（终审 A）

- `src/modules/auth/PasswordAuthController.ts`：`recordRegisterAttempt` 由「入口即计数」后移到 `verifyCode` 通过之后；`isRegisterThrottled` 检查位置不变。未通过验证码的尝试不再占用配额，杜绝他人用错验证码请求把目标账号配额打满导致其无法首次设密码。
- `src/modules/auth/loginThrottle.ts`：注册频控口径注释同步更新（仅注释，无行为/签名变化）。
- `src/modules/auth/AGENTS.md`：注册接口补充注册频控口径，`loginThrottle.ts` 职责补充注册频控。
- `src/modules/auth/__tests__/password-auth.spec.ts`：替换/新增用例覆盖「错误验证码不消耗配额」与「验证码通过后超限 429、成功注册复位」。
```

- [ ] **Step 9: Commit（`changelog-pending.md` 不入库）**

```bash
git add src/modules/auth/PasswordAuthController.ts src/modules/auth/loginThrottle.ts src/modules/auth/AGENTS.md src/modules/auth/__tests__/password-auth.spec.ts
git commit -m "修复(auth): 注册频控改为验证码通过后计数，避免他人打满配额"
```

---

### Task 9: B — scrypt 异步化 + 有界并发

**Files:**
- Modify: `src/modules/auth/passwordUtils.ts`（scrypt 调用全部异步化 + `MAX_CONCURRENT_SCRYPT` 信号量）
- Modify: `src/modules/auth/PasswordAuthController.ts`（注册 `hashPassword`、登录 `verifyPasswordConstantTime` 两处 `await`）
- Modify: `src/modules/auth/AGENTS.md`（`passwordUtils.ts` 职责补充「异步 + 有界并发」）
- Modify: `changelog-pending.md`（追加，仅本地、不入库）
- Test: `src/modules/auth/__tests__/password-utils.spec.ts`（整体替换）、`src/modules/auth/__tests__/password-auth.spec.ts`（5 处 mock 内 `hashPassword` 加 `await`）

**Interfaces:**
- Consumes: Node 内置 `crypto.scrypt`（线程池版，回调式）
- Produces:
  - `MAX_CONCURRENT_SCRYPT = 4`（`number`，在途 scrypt 上限）
  - `hashPassword(password: string): Promise<string>`（签名变更：原 `string`）
  - `verifyPassword(password: string, stored: string | null): Promise<boolean>`（签名变更：原 `boolean`）
  - `verifyPasswordConstantTime(password: string, stored: string | null): Promise<boolean>`（签名变更：原 `boolean`）

- [ ] **Step 1: 写失败测试（异步化 + 有界并发的行为断言）**

在 `src/modules/auth/__tests__/password-utils.spec.ts` 末尾追加（import 行同时补 `MAX_CONCURRENT_SCRYPT`）：

```ts
test('scrypt 异步化后不阻塞事件循环（事件循环先于 scrypt 完成推进）', async () => {
    const order: string[] = [];
    const pending = hashPassword('abc12345');
    void pending.then(() => order.push('scrypt'));
    setImmediate(() => order.push('tick'));
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 同步 scryptSync 实现下 'scrypt' 必然先入队；异步实现下事件循环在 scrypt 完成前即可推进
    assert.deepEqual(order, ['tick', 'scrypt']);
});

test('并发超过 MAX_CONCURRENT_SCRYPT 时排队等待且不丢失', async () => {
    assert.ok(MAX_CONCURRENT_SCRYPT >= 1, '并发上限应为正数');
    const burst = MAX_CONCURRENT_SCRYPT + 3;
    const results = await Promise.all(Array.from({ length: burst }, () => verifyPasswordConstantTime('abc12345', null)));
    assert.deepEqual(results, Array.from({ length: burst }, () => false));
    // 突发结束后额度未泄漏：仍能正常完成一次校验
    const stored = await hashPassword('abc12345');
    assert.equal(await verifyPassword('abc12345', stored), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --import tsx --test src/modules/auth/__tests__/password-utils.spec.ts`

Expected: FAIL —— `MAX_CONCURRENT_SCRYPT` 为 `undefined`（import 报错/断言失败）；且 `pending.then` 在同步实现下不是函数（`hashPassword` 目前返回 `string`）。

- [ ] **Step 3: 实现最小代码（工具层整体替换）**

用下面内容整体替换 `src/modules/auth/passwordUtils.ts`：

```ts
import crypto from 'crypto';

// 密码散列：零依赖 scrypt（格式 scrypt$N$r$p$salt$hash）
// 选 scrypt 而非 bcrypt/argon2，避免新增原生依赖；参数取 Node 默认档位。
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
// 校验时的成本参数上界，防止被篡改的存储串引发 CPU/内存放大
const SCRYPT_MAX_N = 32768;
const SCRYPT_MAX_R = 16;
const SCRYPT_MAX_P = 4;
const SCRYPT_MAX_KEYLEN = 128;

// B：scrypt 是 CPU 密集操作（单次数十毫秒），同步版 scryptSync 会阻塞事件循环，
// 使随机账号洪泛可让整个进程失去响应。改用线程池版 crypto.scrypt，并用信号量把「在途」
// 任务限制在 MAX_CONCURRENT_SCRYPT（对齐 libuv 默认线程池大小）；超出部分排队等待而非拒绝。
export const MAX_CONCURRENT_SCRYPT = 4;

type ScryptParams = { N: number; r: number; p: number };

let activeScrypt = 0;
const scryptWaiters: Array<() => void> = [];

function acquireScryptSlot(): Promise<void> {
    if (activeScrypt < MAX_CONCURRENT_SCRYPT) {
        activeScrypt += 1;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        scryptWaiters.push(resolve);
    });
}

function releaseScryptSlot(): void {
    const next = scryptWaiters.shift();
    if (next) {
        // 有等待者：额度直接移交（activeScrypt 保持不变）
        next();
        return;
    }
    activeScrypt -= 1;
}

async function scryptAsync(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
    await acquireScryptSlot();
    try {
        return await new Promise<Buffer>((resolve, reject) => {
            crypto.scrypt(password, salt, keylen, params, (err, derivedKey) => {
                if (err) reject(err);
                else resolve(derivedKey);
            });
        });
    } finally {
        releaseScryptSlot();
    }
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = await scryptAsync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
    if (!stored) return false;
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    // 严格十进制，拒绝 parseInt 会放过的 `16384x`、` 16384 ` 等非规范串
    if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
    // N 必须是 2 的幂且有上界，避免巨大 N 导致 scrypt 申请 GB 级内存
    if (n < 2 || n > SCRYPT_MAX_N || (n & (n - 1)) !== 0) return false;
    if (r < 1 || r > SCRYPT_MAX_R || p < 1 || p > SCRYPT_MAX_P) return false;

    let salt: Buffer;
    let expected: Buffer;
    try {
        salt = Buffer.from(parts[4], 'base64');
        expected = Buffer.from(parts[5], 'base64');
    } catch {
        return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;
    if (expected.length > SCRYPT_MAX_KEYLEN) return false;

    let actual: Buffer;
    try {
        // keylen 取自存储串的散列长度，故返回长度必然相等，无需再做长度比较
        actual = await scryptAsync(password, salt, expected.length, { N: n, r, p });
    } catch {
        return false;
    }
    return crypto.timingSafeEqual(actual, expected);
}

// I1：恒定成本校验。
// verifyPassword 在 stored 为空时零成本返回 false，使「账号不存在 / 未设密码」与「密码错误」
// 在响应耗时上可区分，与「登录失败口径统一、不暴露账号存在性」的目标矛盾。
// 本函数对空 stored 也执行一次同参数 scrypt 以抹平耗时；verifyPassword 自身语义不变。
// dummy 用模块级固定随机盐：scrypt 成本只取决于 N/r/p/keylen，与盐/口令取值无关，
// 故无需（异步化后也无法）在加载期构造完整 dummy 散列。
const DUMMY_SALT = crypto.randomBytes(SALT_BYTES);

export async function verifyPasswordConstantTime(password: string, stored: string | null): Promise<boolean> {
    if (!stored) {
        // 对 dummy 盐执行等价成本 scrypt，结果丢弃，仅用于对齐耗时
        try {
            await scryptAsync(password, DUMMY_SALT, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
        } catch {
            // 极端输入（如超长 password）导致 scrypt 抛错时同样按失败处理
        }
        return false;
    }
    return verifyPassword(password, stored);
}

// I3：密码长度上限，阻断超长输入进入 scrypt 造成 CPU/内存放大（128 位足以覆盖任何正常口令）
export const MAX_PASSWORD_LENGTH = 128;

export function isStrongPassword(password: string): boolean {
    if (typeof password !== 'string' || password.length < 8) return false;
    if (password.length > MAX_PASSWORD_LENGTH) return false;
    return /[A-Za-z]/.test(password) && /\d/.test(password);
}
```

- [ ] **Step 4: 改两处调用点**

`src/modules/auth/PasswordAuthController.ts`：

```ts
            const hash = await hashPassword(password);
```

```ts
            const passOk = await verifyPasswordConstantTime(password, row?.password_hash ?? null);
```

- [ ] **Step 5: 用改后语义替换单元测试文件**

用下面内容整体替换 `src/modules/auth/__tests__/password-utils.spec.ts`（既有断言全部保留，仅补 `await`/`async`，并含 Step 1 的两个新用例）：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, isStrongPassword, verifyPasswordConstantTime, MAX_PASSWORD_LENGTH, MAX_CONCURRENT_SCRYPT } from '../passwordUtils';

test('hashPassword 生成 scrypt$ 前缀，且 verifyPassword 正确验证', async () => {
    const stored = await hashPassword('abc12345');
    assert.ok(stored.startsWith('scrypt$'));
    assert.equal(stored.split('$').length, 6);
    assert.equal(await verifyPassword('abc12345', stored), true);
    assert.equal(await verifyPassword('abc12346', stored), false);
});

test('verifyPassword 对 null / 非法格式返回 false', async () => {
    assert.equal(await verifyPassword('abc12345', null), false);
    assert.equal(await verifyPassword('abc12345', ''), false);
    assert.equal(await verifyPassword('abc12345', 'plaintext'), false);
    assert.equal(await verifyPassword('abc12345', 'scrypt$bad'), false);
});

test('isStrongPassword 校验长度与字母数字组合', () => {
    assert.equal(isStrongPassword('abc12345'), true);
    assert.equal(isStrongPassword('abcdefgh'), false);
    assert.equal(isStrongPassword('12345678'), false);
    assert.equal(isStrongPassword('abc123'), false);
});

test('hashPassword 使用绑定参数（N/r/p/keylen/salt）', async () => {
    const stored = await hashPassword('abc12345');
    const parts = stored.split('$');
    assert.deepEqual(parts.slice(1, 4), ['16384', '8', '1']);
    assert.equal(Buffer.from(parts[4], 'base64').length, 16);
    assert.equal(Buffer.from(parts[5], 'base64').length, 64);
});

test('hashPassword 每次盐不同，且各自可验证', async () => {
    const a = await hashPassword('abc12345');
    const b = await hashPassword('abc12345');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('abc12345', a), true);
    assert.equal(await verifyPassword('abc12345', b), true);
});

test('verifyPassword 拒绝非规范数值段与超限成本参数', async () => {
    const parts = (await hashPassword('abc12345')).split('$');
    const mk = (n: string) => ['scrypt', n, '8', '1', parts[4], parts[5]].join('$');
    assert.equal(await verifyPassword('abc12345', mk('16384x')), false);
    assert.equal(await verifyPassword('abc12345', mk(' 16384 ')), false);
    assert.equal(await verifyPassword('abc12345', mk('9999')), false);
    assert.equal(await verifyPassword('abc12345', mk('1048576')), false);
    assert.equal(await verifyPassword('abc12345', parts.join('$')), true);
});

test('verifyPasswordConstantTime 结果与 verifyPassword 一致（null / 正确 / 错误）', async () => {
    assert.equal(await verifyPasswordConstantTime('abc12345', null), false);
    const stored = await hashPassword('abc12345');
    assert.equal(await verifyPasswordConstantTime('abc12345', stored), true);
    assert.equal(await verifyPasswordConstantTime('abc12346', stored), false);
});

test('verifyPasswordConstantTime 对空 stored 仍执行 scrypt（耗时下界）', async () => {
    const start = process.hrtime.bigint();
    assert.equal(await verifyPasswordConstantTime('abc12345', null), false);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1000000;
    // N=16384 的单次 scrypt 为数十毫秒量级；纯比较路径仅零点几毫秒。
    // 取 1ms 作为保守下界，避免 CI 抖动造成 flaky。
    assert.ok(elapsedMs > 1, `期望 scrypt 级耗时，实际 ${elapsedMs.toFixed(3)}ms`);
});

test('MAX_PASSWORD_LENGTH 为 128，isStrongPassword 接受 128 位并拒绝 129 位', () => {
    assert.equal(MAX_PASSWORD_LENGTH, 128);
    const ok = `a1${'x'.repeat(126)}`;
    const tooLong = `a1${'x'.repeat(127)}`;
    assert.equal(ok.length, 128);
    assert.equal(tooLong.length, 129);
    assert.equal(isStrongPassword(ok), true);
    assert.equal(isStrongPassword(tooLong), false);
});

test('scrypt 异步化后不阻塞事件循环（事件循环先于 scrypt 完成推进）', async () => {
    const order: string[] = [];
    const pending = hashPassword('abc12345');
    void pending.then(() => order.push('scrypt'));
    setImmediate(() => order.push('tick'));
    await pending;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // 同步 scryptSync 实现下 'scrypt' 必然先入队；异步实现下事件循环在 scrypt 完成前即可推进
    assert.deepEqual(order, ['tick', 'scrypt']);
});

test('并发超过 MAX_CONCURRENT_SCRYPT 时排队等待且不丢失', async () => {
    assert.ok(MAX_CONCURRENT_SCRYPT >= 1, '并发上限应为正数');
    const burst = MAX_CONCURRENT_SCRYPT + 3;
    const results = await Promise.all(Array.from({ length: burst }, () => verifyPasswordConstantTime('abc12345', null)));
    assert.deepEqual(results, Array.from({ length: burst }, () => false));
    // 突发结束后额度未泄漏：仍能正常完成一次校验
    const stored = await hashPassword('abc12345');
    assert.equal(await verifyPassword('abc12345', stored), true);
});
```

- [ ] **Step 6: 适配集成测试（mock 内 `hashPassword` 加 `await`）**

`src/modules/auth/__tests__/password-auth.spec.ts` 中有 5 处 mock 返回 `password_hash: hashPassword('abc12345')`（约在第 142、156、172、194、241 行），全部改为：

```ts
password_hash: await hashPassword('abc12345')
```

（这些 mock 实现均为 `async` 函数，可直接 `await`；文件内其余断言无需改动。）

- [ ] **Step 7: 运行测试确认通过**

Run: `node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"`

Expected: PASS（本模块全部用例全绿，含新增的异步化与并发排队用例）

- [ ] **Step 8: 类型检查与全库基线核对**

Run: `npx tsc --noEmit; npm test 2>&1 | Select-String -Pattern '^ℹ (tests|pass|fail)'`

Expected: `tsc` 无输出、退出码 0（三个函数签名变更后全仓无其他调用点，已核查：`passwordUtils` 仅被 `PasswordAuthController.ts` 与两个 auth 测试文件引用）；`npm test` 汇总为 `ℹ tests 754`、`ℹ pass 742`、`ℹ fail 12`（本任务净新增 2 用例；**`fail` 必须仍为 12**）

- [ ] **Step 9: 更新文档与修改记录**

`src/modules/auth/AGENTS.md` 第 40 行改为：

```markdown
- `passwordUtils.ts` — scrypt 密码散列（hash/verify/强度校验；异步 + 在途并发上限）
```

`src/modules/auth/AGENTS.md` 第 60 行（依赖的 shared 类型清单）改为：

```markdown
- `modules/auth/loginThrottle` — 登录失败防刷计数与注册频控
```

（该项来自 Task 8 任务审查的 Minor：该行此前只写「登录失败防刷计数」，与 Task 8 引入的注册频控职责不一致。）

在 `changelog-pending.md` **文件顶部**追加：

```markdown
## 2026-09-27 修复(auth): scrypt 异步化并限制在途并发（终审 B）

- `src/modules/auth/passwordUtils.ts`：`hashPassword` / `verifyPassword` / `verifyPasswordConstantTime` 由 `scryptSync` 改为线程池版 `crypto.scrypt`（返回 `Promise`）；新增 `MAX_CONCURRENT_SCRYPT = 4` 信号量（在途上限，超出排队等待）；dummy 由模块加载期散列改为模块级固定随机盐 `DUMMY_SALT`。
- `src/modules/auth/PasswordAuthController.ts`：注册 `hashPassword`、登录 `verifyPasswordConstantTime` 调用点加 `await`。
- `src/modules/auth/AGENTS.md`：`passwordUtils.ts` 职责补充「异步 + 在途并发上限」。
- 影响：事件循环不再被 scrypt 阻塞，随机账号洪泛退化为请求排队而非进程失去响应；成本参数（N/r/p/keylen）与散列格式不变，存量散列仍可校验。
```

- [ ] **Step 10: Commit（`changelog-pending.md` 不入库）**

```bash
git add src/modules/auth/passwordUtils.ts src/modules/auth/PasswordAuthController.ts src/modules/auth/AGENTS.md src/modules/auth/__tests__/password-utils.spec.ts src/modules/auth/__tests__/password-auth.spec.ts
git commit -m "修复(auth): scrypt 异步化并限制在途并发，消除事件循环阻塞"
```

---

## 追加任务（2026-09-27）— Important C：fail-open 测试后门收紧

### Task 10: C — 三处 `NODE_ENV !== 'production'` 后门收紧为 `=== 'test'`

**目标**：消除生产 `NODE_ENV` 漏配（staging / 容器）时万能码 `'123456'` 与 ws `user_<openid>` 前缀直接放行的真实高危，机械收紧为仅 `NODE_ENV === 'test'` 生效。用户确认：ws 保留 `user_<openid>` 分支、仅收紧门槛；不做 IP/网关层限流、M1、M3–M7。

- [ ] **Step 1: 先写失败用例（RED）**

- `src/modules/auth/__tests__/sms-auth.spec.ts`：新增「短信登录验证码后门仅在 NODE_ENV=test 生效」——临时置 `NODE_ENV=development`，断言 `'123456'` 登录 → 400「验证码错误或已过期」，`finally` 还原。
- `src/modules/auth/__tests__/email-auth.spec.ts`：新增两条同型用例——「邮箱登录验证码后门仅在 NODE_ENV=test 生效」、「bindWechat 验证码后门仅在 NODE_ENV=test 生效（邮箱/手机双身份）」。
- `src/core/ws/__tests__/handler.spec.ts`（新建）：`initWebSocket` 真实 http server 集成用例——`NODE_ENV=test` 时 `user_<openid>` 放行并注册为该 openid（正向）；`NODE_ENV=development` 时不再放行、连接以匿名身份注册（负向）。
- 运行确认失败原因正确（非报错）：sms/email 登录为 `200 !== 400`、bindWechat 为 `403 !== 400`、ws 为 `true !== false`。

- [ ] **Step 2: 最小实现（GREEN）**

- `src/modules/auth/SmsAuthController.ts`：`verifyCode` 的 `isDev = NODE_ENV !== 'production'` → `isTest = process.env.NODE_ENV === 'test'`；同步文件头注释语义。
- `src/modules/auth/EmailAuthController.ts`：`verifyCode` 同款替换；`bindWechat` 双身份内联判定 `isDev` → `isTest`。
- `src/core/ws/handler.ts`：`parseUserFromToken` 的 `process.env.NODE_ENV !== 'production'` → `=== 'test'`（保留 `user_` 分支）；同步注释。
- `src/core/email/EmailService.ts` / `src/core/sms/SmsService.ts`：`EMAIL_DEV_TEST_CODE` / `SMS_DEV_TEST_CODE` 注释改为「仅 test 环境放行（NODE_ENV === 'test'）」；发送侧 dev 日志回显（非后门）不动。

- [ ] **Step 3: 运行确认通过**

```bash
node --import tsx --test "src/modules/auth/__tests__/*.spec.ts" "src/core/ws/__tests__/*.spec.ts"
npx tsc --noEmit
npm test   # 全库 fail 基线应仍为 12
```

- [ ] **Step 4: 文档与修改记录**

- 更新 spec §10.C 状态（去掉「本次不实施」）+ §10 引言；本 plan 追加 Task 10。
- `src/modules/auth/AGENTS.md`（如涉及后门口径段落）同步。
- `changelog-pending.md` 顶部追加：

```markdown
## 2026-09-27 修复(auth): 收紧验证码与 ws 本地联调测试后门为仅 NODE_ENV=test（终审 C）

- `src/modules/auth/SmsAuthController.ts` / `EmailAuthController.ts`：`verifyCode` 与 `bindWechat` 双身份判定的 `NODE_ENV !== 'production'` 收紧为 `=== 'test'`。
- `src/core/ws/handler.ts`：`parseUserFromToken` 的 `user_<openid>` 本地联调前缀收紧为仅 `NODE_ENV === 'test'` 生效（保留分支）。
- `src/core/email/EmailService.ts` / `src/core/sms/SmsService.ts`：测试码注释语义同步（发送侧 dev 回显非后门，未改动）。
- 影响：生产 `NODE_ENV` 漏配时万能码/`user_` 前缀不再放行；测试仍以 `NODE_ENV=test` 运行，`'123456'` 照常放行，既有用例零回归。
```

- [ ] **Step 5: Commit（`changelog-pending.md` 不入库）**

```bash
git add src/modules/auth/SmsAuthController.ts src/modules/auth/EmailAuthController.ts src/core/ws/handler.ts src/core/email/EmailService.ts src/core/sms/SmsService.ts src/modules/auth/__tests__/sms-auth.spec.ts src/modules/auth/__tests__/email-auth.spec.ts src/core/ws/__tests__/handler.spec.ts
git commit -m "修复(auth): 收紧验证码与 ws 本地联调测试后门为仅 NODE_ENV=test"
```

---

## 追加任务（2026-09-27）— M1：`redisIncr` 原子化

### Task 11: M1 — `redisIncr` 改用单条 Lua 原子脚本

**目标**：消除 `INCR` 与 `EXPIRE` 两步之间进程中断导致计数键无 TTL、账号永久 429 的可用性缺陷。方案 A（单条 Lua），并自愈历史无 TTL 键。用户确认：**仅做 M1**，不做 M7（`req.ip` 现仅用于日志）。

**Spec:** §11（`docs/superpowers/specs/2026-09-26-auth-hardening-design.md`）

**Files:**
- Modify: `src/modules/auth/loginThrottle.ts`（新增 `INCR_WITH_TTL_LUA`、`ThrottleRedisClient`；`redisIncr` 改为导出 + 可注入客户端）
- Test: `src/modules/auth/__tests__/login-throttle.spec.ts`

- [ ] **Step 1: 写失败测试（RED）**

在 `src/modules/auth/__tests__/login-throttle.spec.ts` 的 import 中追加 `redisIncr`，并在文件末尾新增用例（假客户端**只实现 `eval`**，不含 `incr`/`expire`）：

```ts
test('redisIncr 以单条原子脚本设置计数与 TTL（不回退两步命令）', async () => {
    const calls: Array<[string, number, (string | number)[]]> = [];
    const fake = {
        eval: async (script: string, numkeys: number, ...args: (string | number)[]) => {
            calls.push([script, numkeys, args]);
            return 1;
        },
    };
    await redisIncr('p:', 'acct', 900, fake);
    assert.equal(calls.length, 1);
    const [script, numkeys, args] = calls[0];
    assert.equal(numkeys, 1);
    assert.deepEqual(args, ['p:acct', 900]);
    assert.match(script, /INCR/);
    assert.match(script, /EXPIRE/);
});
```

运行确认失败原因为「`redisIncr` 未导出 / 参数不匹配」，而非其它报错。

- [ ] **Step 2: 最小实现（GREEN）**

`src/modules/auth/loginThrottle.ts`：

```ts
const INCR_WITH_TTL_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return c
`;

export interface ThrottleRedisClient {
    eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export async function redisIncr(
    prefix: string,
    key: string,
    windowSec: number,
    client: ThrottleRedisClient = redis,
): Promise<void> {
    await client.eval(INCR_WITH_TTL_LUA, 1, prefix + key, windowSec);
}
```

（`recordAttempt` 调用点不变。若 ioredis `eval` 类型与接口不完全匹配，用最小适配解决，禁止 `any`。）

- [ ] **Step 3: 运行确认通过**

```bash
node --import tsx --test "src/modules/auth/__tests__/*.spec.ts"
npx tsc --noEmit
npm test   # 全库 fail 基线应仍为 12
```

- [ ] **Step 4: 文档与修改记录**

- 更新 spec §11 状态；本 plan 追加 Task 11 并更新文末「不在本次实现」段落（M1 移出）。
- `changelog-pending.md` 顶部追加：

```markdown
## 2026-09-27 修复(auth): redisIncr 改用单条 Lua 原子脚本（M1）

- `src/modules/auth/loginThrottle.ts`：`INCR` + 条件 `EXPIRE` 两步改为单条 Lua 原子执行（含 `TTL < 0` 自愈），消除进程中断致计数键无 TTL、账号永久 429 的缺陷。
- `redisIncr` 导出并可注入最小客户端接口 `ThrottleRedisClient`（默认单例 redis），Redis 集成边界首次可单测。
- 语义不变（固定窗口、阈值、窗口、内存兜底、对外状态码/文案均不变）；零新增依赖。
```

- [ ] **Step 5: Commit（`changelog-pending.md` 不入库）**

```bash
git add src/modules/auth/loginThrottle.ts src/modules/auth/__tests__/login-throttle.spec.ts
git commit -m "修复(auth): redisIncr 改用单条 Lua 原子脚本，消除无 TTL 致永久 429"
```

---

## 验收对照（spec §8）

1. 定向 auth 用例全绿（含 T1–T12 新增用例与既有用例），且全库 `npm test` 无新增失败（基线 `fail 12`）→ Task 1/2/3/4/5/6 各自的「运行确认通过」步骤 + Task 7 Step 4。
2. `npx tsc --noEmit` 无错误 → Task 7 Step 4。
3. 登录路径对「账号不存在 / 未设密码 / 密码错误」执行等价成本 scrypt → Task 1 Step 3 的代码位置（`passwordLogin` 已无 `!!row`）+ Task 1 Step 4 的耗时下界用例 + 代码审查。
4. `auth/AGENTS.md` 口径与实现一致 → Task 7 Step 1-2。
5. 现有 401/429 口径与文案未变（仅新增注册超长 400 与注册频控 429）→ Task 1/2/4/5 的集成用例断言。
6. 注册频控只统计「验证码校验通过」的尝试，且成功注册后复位 → Task 8 Step 1/4/5 的集成用例。
7. scrypt 不再阻塞事件循环、在途并发受限且超限排队不丢失 → Task 9 Step 1/5/7 的单元用例。
8. 三处 fail-open 测试后门（注册/登录万能码 + ws `user_` 前缀）仅在 `NODE_ENV=test` 生效 → Task 10 Step 1/3 的新增用例。

**不在本次实现（后续独立项）**：IP/网关层限流（A 修订后注册接口的未认证洪泛不再被账号维度计数器拦截）；M3–M7。（`SmsAuthController`/`EmailAuthController`/`ws/handler` 的 `NODE_ENV !== 'production'` 后门已由 Task 10 实施；M1 `redisIncr` 的 `INCR`+`EXPIRE` 非原子已由 Task 11 实施。）