/**
 * 公共配置控制器
 * 
 * 提供前端需要的非敏感配置项，避免前端维护 .env 文件
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';

export class ConfigController {
    /**
     * GET /api/config/public
     * 获取前端公共配置
     */
    static async getPublicConfig(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const config = {
                // 飞书 OAuth 配置
                feishuAppId: process.env.FEISHU_APP_ID || '',

                // 企业邀请配置（企业自建应用需先邀请用户加入企业）
                feishuEnterpriseInviteLink: process.env.FEISHU_ENTERPRISE_INVITE_LINK || '',
                feishuEnterpriseInviteQrUrl: process.env.FEISHU_ENTERPRISE_INVITE_QR_URL || '',

                // API 地址（前端已通过 VUE_APP_API_TARGET 获取，这里可选）
                apiBaseUrl: process.env.FRONTEND_URL || '',

                // 其他公共配置...
            };
            createResponse(res, 200, 'success', config);
        } catch (err: any) {
            console.error('[ConfigController] getPublicConfig error:', err.message);
            createResponse(res, 500, '获取配置失败');
        }
    }
}