/**
 * 短信发送服务抽象
 *
 * - 开发/未接入服务商：仅日志回显验证码（login/bind 校验阶段放行固定测试码 SMS_DEV_TEST_CODE）。
 * - 生产接入：SMS_PROVIDER=aliyun 走阿里云"号码认证·短信认证"（dypnsapi.SendSmsVerifyCode）真实发短信——
 *   该产品免企业签名资质 / 模板审核，用号码认证工作台配置的系统签名 + 预置模板（登录 100001 / 绑定 100004 等）即可下发。
 *   验证码由本项目本地生成并存 store 校验（smsCodeStore），阿里云仅作为"发信通道"把本地验证码
 *   通过 TemplateParam 下发到用户手机（不在阿里云侧自动生成验证码）。
 * - tencent 渠道保留占位（如需请接入企业短信服务）。
 */
import Client, { SendSmsVerifyCodeRequest } from '@alicloud/dypnsapi20170525';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { generateSmsCode, isValidMainlandPhone } from './smsCodeStore';

/** 开发环境固定测试码：登录/绑定校验时放行（NODE_ENV !== 'production'） */
export const SMS_DEV_TEST_CODE = '123456';

/** 短信渠道类型 */
type SmsProvider = 'aliyun' | 'tencent';

/** 验证码用途场景：用于选择阿里云预置模板（模板 ∈ 号码认证工作台「模板配置」列出的预置模板 code） */
export type SmsScenario = 'login' | 'bind';

/** 验证码有效期（秒），模板中 `min` 变量取 5；与 smsCodeStore 的 TTL 对齐 */
const SMS_VALID_SECONDS = 300;

/** 生产短信配置（从环境变量读取并校验） */
interface SmsConfig {
    provider: SmsProvider;
    accessKeyId: string;
    accessKeySecret: string;
    signName: string;
    templateCode: string; // 登录/注册模板 code（默认 100001）
    region: string;
}

/**
 * 读取生产短信配置。
 * - 未设置 SMS_PROVIDER：返回 null（视为未接入，send 抛明确错误引导配置）
 * - 设置但缺必填项：抛错列出缺失字段，避免误发到错误账户
 */
function readSmsConfig(): SmsConfig | null {
    const provider = process.env.SMS_PROVIDER;
    if (!provider) return null;
    if (provider !== 'aliyun' && provider !== 'tencent') {
        throw new Error(`SMS_PROVIDER 仅支持 aliyun|tencent，当前为 "${provider}"`);
    }
    const accessKeyId = process.env.SMS_ACCESS_KEY_ID ?? '';
    const accessKeySecret = process.env.SMS_ACCESS_KEY_SECRET ?? '';
    const signName = process.env.SMS_SIGN_NAME ?? '';
    // 登录/注册模板：默认 100001（号码认证工作台「登录/注册模板」预置 code）
    const templateCode = process.env.SMS_TEMPLATE_CODE ?? (provider === 'aliyun' ? '100001' : '');
    const region = process.env.SMS_REGION ?? (provider === 'aliyun' ? 'cn-hangzhou' : 'ap-guangzhou');
    const missing = [
        accessKeyId ? '' : 'SMS_ACCESS_KEY_ID',
        accessKeySecret ? '' : 'SMS_ACCESS_KEY_SECRET',
        signName ? '' : 'SMS_SIGN_NAME',
        templateCode ? '' : 'SMS_TEMPLATE_CODE',
    ].filter(Boolean);
    if (missing.length > 0) {
        throw new Error(`短信配置缺失：${missing.join(', ')}（SMS_PROVIDER=${provider}）`);
    }
    return { provider, accessKeyId, accessKeySecret, signName, templateCode, region };
}

/** 按场景解析模板 code：登录走 SMS_TEMPLATE_CODE（预置 100001），绑定走 SMS_TEMPLATE_BIND（预置 100004） */
function resolveTemplate(cfg: SmsConfig, scenario: SmsScenario): string {
    switch (scenario) {
        case 'bind':
            return process.env.SMS_TEMPLATE_BIND || cfg.templateCode;
        case 'login':
        default:
            return cfg.templateCode;
    }
}

export class SmsService {
    /** 发送验证码。dev 仅日志回显；生产按 SMS_PROVIDER 分发真实渠道（未接入/未配置时抛错，由调用方降级返回错误）。 */
    static async send(phone: string, code: string, scenario: SmsScenario = 'login'): Promise<void> {
        const isDev = process.env.NODE_ENV !== 'production';
        if (isDev) {
            console.log(`[SMS][dev] 验证码 ${code} -> ${phone}（开发环境不真发短信）`);
            return;
        }

        // 生产：读取配置；未配置 SMS_PROVIDER 视为未接入
        let cfg: SmsConfig | null;
        try {
            cfg = readSmsConfig();
        } catch (err: unknown) {
            throw new Error(`短信服务未配置：${err instanceof Error ? err.message : String(err)}`);
        }
        if (!cfg) {
            throw new Error('短信服务未配置：请在环境变量设置 SMS_PROVIDER=aliyun|tencent 及对应凭证（见 .env.example）');
        }

        if (cfg.provider === 'aliyun') {
            await SmsService.sendViaAliyun(cfg, phone, code, scenario);
        } else {
            await SmsService.sendViaTencent(cfg, phone, code);
        }
    }

    /**
     * 阿里云"号码认证·短信认证"接入点（dypnsapi SendSmsVerifyCode）。
     * 参考：https://help.aliyun.com/document_detail/313209.html
     * 特点：免企业签名/模板审核，用号码认证工作台配置的"短信认证签名 + 预置模板"即可下发。
     * 本实现把核验码本地生成（smsCodeStore），阿里云仅作为发信通道——TemplateParam 填本地 code。
     */
    private static async sendViaAliyun(
        cfg: SmsConfig,
        phone: string,
        code: string,
        scenario: SmsScenario,
    ): Promise<void> {
        const client = new Client(
            new $OpenApiUtil.Config({
                accessKeyId: cfg.accessKeyId,
                accessKeySecret: cfg.accessKeySecret,
                endpoint: 'dypnsapi.aliyuncs.com',
                regionId: cfg.region,
            }),
        );

        const req = new SendSmsVerifyCodeRequest({
            phoneNumber: `86${phone}`,
            countryCode: '86', // 仅支持中国大陆号码
            signName: cfg.signName, // 短信认证签名（号码认证工作台）
            templateCode: resolveTemplate(cfg, scenario), // 预置验证码模板（登录 100001 / 绑定 100004）
            templateParam: JSON.stringify({ code, min: String(SMS_VALID_SECONDS / 60) }),
            codeLength: code.length, // 纯数字，长度与本地生成一致
            codeType: 1, // 纯数字验证码
            validTime: SMS_VALID_SECONDS, // 与本地 store TTL 对齐
            duplicatePolicy: 1, // 同号同场景有效期内的最新验证码覆盖旧码
            interval: 60,
        });

        const resp = await client.sendSmsVerifyCode(req);
        const body = resp?.body;
        if (!body || body.success !== true || body.code !== 'OK') {
            throw new Error(
                `阿里云短信发送失败：code=${body?.code ?? 'unknown'} message=${body?.message ?? ''}${body?.model?.bizId ? ` bizId=${body.model.bizId}` : ''}`,
            );
        }
    }

    /**
     * 腾讯云短信（Sms）接入点。
     * 接入参考：https://cloud.tencent.com/document/product/382/43197
     * 启用方式：完成企业签名 + 验证码模板审核后，安装官方 SDK 并替换本函数体：
     *   npm i tencentcloud-sdk-nodejs-sms
     *   const client = new SmsClient({ credential, region, profile });
     *   await client.SendSms({ PhoneNumberSet: [phone], SmsSdkAppId, SignName: signName, TemplateId: templateCode, TemplateParamSet: [code] });
     */
    private static async sendViaTencent(
        _cfg: SmsConfig,
        _phone: string,
        _code: string,
    ): Promise<void> {
        // 本期不真发：待企业签名/模板审核通过后按上述注释接入
        throw new Error('腾讯云短信渠道未启用：需先完成企业签名与验证码模板审核，再在 sendViaTencent 接入官方 SDK');
    }
}

export { generateSmsCode, isValidMainlandPhone };
