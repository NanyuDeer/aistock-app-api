import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createResponse } from '../../shared/utils/response';
import { ScanLoginController } from '../auth/scanLoginController';

export class WechatEventController {
    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[WxEvent][${stage}] ${ts} ${message}${detail}`);
    }

    private static sha1Hex(content: string): string {
        return crypto.createHash('sha1').update(content).digest('hex');
    }

    private static verifySignature(timestamp?: string, nonce?: string, signature?: string): boolean {
        if (!timestamp || !nonce || !signature) return false;
        const token = process.env.WECHAT_TOKEN;
        if (!token) return false;
        const raw = [token, timestamp, nonce].sort().join('');
        const expected = WechatEventController.sha1Hex(raw);
        return expected === signature;
    }

    private static extractXmlTag(xml: string, tag: string): string {
        const cdataRe = new RegExp(`<${tag}><!\\[CDATA\\[([^\\]]*?)\\]\\]></${tag}>`);
        const cdataMatch = xml.match(cdataRe);
        if (cdataMatch) return cdataMatch[1];

        const plainRe = new RegExp(`<${tag}>([^<]*)</${tag}>`);
        const plainMatch = xml.match(plainRe);
        return plainMatch ? plainMatch[1] : '';
    }

    static async handle(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const signature = req.query.signature as string;
        const timestamp = req.query.timestamp as string;
        const nonce = req.query.nonce as string;
        const echostr = req.query.echostr as string;

        const ok = WechatEventController.verifySignature(timestamp, nonce, signature);
        if (!ok) {
            WechatEventController.log('verify', '❌ 签名校验失败', { signature, timestamp, nonce });
            createResponse(res, 401, 'invalid signature');
            return;
        }

        if (req.method === 'GET') {
            WechatEventController.log('verify', '✅ 校验成功，回显 echostr', { echostr });
            res.setHeader('Content-Type', 'text/plain');
            res.status(200).send(echostr || '');
            return;
        }

        const body = req.body;
        const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        WechatEventController.log('push', '收到推送', { length: bodyStr.length });

        const msgType = WechatEventController.extractXmlTag(bodyStr, 'MsgType');
        const fromUser = WechatEventController.extractXmlTag(bodyStr, 'FromUserName');

        if (msgType === 'event') {
            const event = WechatEventController.extractXmlTag(bodyStr, 'Event');
            const eventKey = WechatEventController.extractXmlTag(bodyStr, 'EventKey');

            WechatEventController.log('push', '事件类型', { event, eventKey, openid: fromUser });

            if (event === 'subscribe' || event === 'SCAN') {
                const sceneStr = event === 'subscribe'
                    ? eventKey.replace(/^qrscene_/, '')
                    : eventKey;

                if (sceneStr && sceneStr.startsWith('login_')) {
                    WechatEventController.log('push', '🔑 扫码登录事件，转交 ScanLoginController', { sceneStr, openid: fromUser });
                    try {
                        await ScanLoginController.handleScanEvent(fromUser, sceneStr);
                        WechatEventController.log('push', '✅ ScanLoginController 处理完成');
                    } catch (err: any) {
                        WechatEventController.log('push', '❌ ScanLoginController 处理失败', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }
        }

        res.setHeader('Content-Type', 'text/plain');
        res.status(200).send('success');
    }
}
