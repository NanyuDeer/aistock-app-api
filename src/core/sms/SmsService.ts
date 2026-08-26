/**
 * 短信发送服务抽象
 *
 * - 开发/未接入服务商：仅日志回显验证码（login/bind 校验阶段放行固定测试码 SMS_DEV_TEST_CODE）。
 * - 生产接入：通过环境变量配置服务商（SMS_PROVIDER=aliyun|tencent + 凭证/签名/模板），
 *   在对应渠道分支替换为官方 SDK 调用。需企业签名资质 + 审核通过的验证码模板，本期不真发，
 *   见设计文档 §9（后续演进）。
 */
import { generateSmsCode, isValidMainlandPhone } from './smsCodeStore';

/** 开发环境固定测试码：登录/绑定校验时放行（NODE_ENV !== 'production'） */
export const SMS_DEV_TEST_CODE = '123456';

/** 短信渠道类型 */
type SmsProvider = 'aliyun' | 'tencent';

/** 生产短信配置（从环境变量读取并校验） */
interface SmsConfig {
    provider: SmsProvider;
    accessKeyId: string;
    accessKeySecret: string;
    signName: string;
    templateCode: string;
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
    const templateCode = process.env.SMS_TEMPLATE_CODE ?? '';
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

export class SmsService {
    /** 发送验证码。dev 仅日志回显；生产按 SMS_PROVIDER 分发真实渠道（未接入/未配置时抛错，由调用方降级返回错误）。 */
    static async send(phone: string, code: string): Promise<void> {
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
            await SmsService.sendViaAliyun(cfg, phone, code);
        } else {
            await SmsService.sendViaTencent(cfg, phone, code);
        }
    }

    /**
     * 阿里云短信（Dysmsapi）接入点。
     * 接入参考：https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms
     * 启用方式：完成企业签名 + 验证码模板审核后，安装官方 SDK 并替换本函数体：
     *   npm i @alicloud/dysmsapi20170525
     *   const client = new Dysmsapi20170525({ accessKeyId, accessKeySecret, endpoint: `dysmsapi.${region}.aliyuncs.com` });
     *   await client.sendSms({ phoneNumbers: phone, signName, templateCode, templateParam: JSON.stringify({ code }) });
     */
    private static async sendViaAliyun(
        _cfg: SmsConfig,
        _phone: string,
        _code: string,
    ): Promise<void> {
        // 本期不真发：待企业签名/模板审核通过后按上述注释接入
        throw new Error('阿里云短信渠道未启用：需先完成企业签名与验证码模板审核，再在 sendViaAliyun 接入官方 SDK');
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
