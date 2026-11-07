/**
 * 用户画像自动挖掘（一期）— 公开清理 / 计数接口
 *
 * - GET    /api/user/profile/inferences/meta：JWT；只返回计数与维度名（**不返回 value**）
 * - DELETE /api/user/profile/inferences：JWT；删除该用户全部推断 + DEL 两个 agent-py 缓存 key
 *
 * 鉴权复用 shared/utils/authGuard.resolveAuth（JWT + 撤销黑名单，与 user 模块同源）。
 * 「永不阻断」：缓存失效失败仅 warning（TTL 300s 兜底）；DB 异常 500 兜底。
 */
import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import { resolveAuth } from '../../shared/utils/authGuard';
import { delAgentInferenceCache, delAgentProfileCache } from '../user/profileController';
import { ProfileMiningService } from './ProfileMiningService';

export class ProfileMiningController {
    private static log(stage: string, message: string, data?: unknown): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[ProfileMining][${stage}] ${ts} ${message}${detail}`);
    }

    /** 只返回计数与维度名（隐私：不向用户展示推断内容，spec §3.8）。 */
    static async meta(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await resolveAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        try {
            // 聚合走 Service（与 clear 同一访问路径，避免表结构变更漏改）
            const meta = await ProfileMiningService.getInferenceMeta(auth.openid);
            createResponse(res, 200, 'success', meta);
        } catch (err) {
            ProfileMiningController.log('meta', 'DB error', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, '查询推断画像失败');
        }
    }

    /** 清除该用户全部推断；显式画像不受影响。 */
    static async clear(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const auth = await resolveAuth(req);
        if (!auth.ok) {
            createResponse(res, auth.code, auth.message);
            return;
        }
        try {
            const deleted = await ProfileMiningService.deleteInferences(auth.openid);
            // 推断变化会影响「显式 + 推断」合并上下文 → 两个缓存 key 一并失效（spec §3.6）
            await delAgentProfileCache(auth.openid);
            await delAgentInferenceCache(auth.openid);
            ProfileMiningController.log('clear', 'inferences deleted', { user_id: auth.openid, deleted });
            createResponse(res, 200, 'success', { deleted });
        } catch (err) {
            ProfileMiningController.log('clear', 'DB error', err instanceof Error ? err.message : String(err));
            createResponse(res, 500, '清除推断画像失败');
        }
    }
}
