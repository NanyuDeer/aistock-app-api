/**
 * 邮箱验证码发送服务（163 SMTP / nodemailer）
 *
 * - 开发/未配置 SMTP：仅日志回显验证码（login/bind 校验阶段放行固定测试码 EMAIL_DEV_TEST_CODE）。
 * - 生产：通过环境变量 EMAIL_SMTP_* 配置 163 邮箱授权码（个人邮箱即可，无需企业资质），
 *   发送真实邮件。未配置 EMAIL_SMTP_USER 视为未接入，send 抛明确错误引导配置。
 */
import nodemailer from 'nodemailer';

/** 开发环境固定测试码：登录/绑定校验时放行（NODE_ENV !== 'production'） */
export const EMAIL_DEV_TEST_CODE = '123456';

/** 邮箱格式校验（简单正则，够用即可） */
export function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 生产 SMTP 配置（从环境变量读取） */
interface EmailConfig {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
}

/** 读取生产 SMTP 配置。未设置 EMAIL_SMTP_USER 返回 null（视为未接入）。
 *  overrides 可整体替换（iterate 通知走独立 QQ SMTP，不影响 163 验证码通道）。 */
function readEmailConfig(overrides?: Partial<EmailConfig>): EmailConfig | null {
    const user = overrides?.user ?? process.env.EMAIL_SMTP_USER ?? '';
    if (!user) return null;
    const host = overrides?.host ?? process.env.EMAIL_SMTP_HOST ?? 'smtp.163.com';
    const port = overrides?.port ?? Number(process.env.EMAIL_SMTP_PORT ?? 465);
    const pass = overrides?.pass ?? process.env.EMAIL_SMTP_PASS ?? '';
    const from = overrides?.from ?? process.env.EMAIL_FROM ?? user;
    if (!pass) {
        throw new Error('EMAIL_SMTP_PASS 未配置（163 邮箱授权码，非登录密码）');
    }
    return { host, port, user, pass, from };
}

export class EmailService {
    /** 发送验证码。dev 仅日志回显；生产按 EMAIL_SMTP_* 配置发送，未配置/失败时抛错由调用方降级返回。 */
    static async send(email: string, code: string): Promise<void> {
        const isDev = process.env.NODE_ENV !== 'production';
        if (isDev) {
            console.log(`[Email][dev] 验证码 ${code} -> ${email}（开发环境不真发邮件）`);
            return;
        }

        let cfg: EmailConfig | null;
        try {
            cfg = readEmailConfig();
        } catch (err: unknown) {
            throw new Error(`邮箱服务未配置：${err instanceof Error ? err.message : String(err)}`);
        }
        if (!cfg) {
            throw new Error('邮箱服务未配置：请在环境变量设置 EMAIL_SMTP_USER / EMAIL_SMTP_PASS（见 .env.example）');
        }

        const transporter = nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port,
            secure: cfg.port === 465,
            auth: { user: cfg.user, pass: cfg.pass },
        });
        await transporter.sendMail({
            from: cfg.from,
            to: email,
            subject: '【洞见】登录验证码',
            text: `您的验证码是 ${code}，5 分钟内有效。若非本人操作请忽略本邮件。`,
        });
    }

    /**
     * 通用文本通知（迭代完成等场景，2026-09-02）。
     * dev 仅日志回显；生产按 EMAIL_SMTP_* 或 overrides（独立 SMTP，如 iterate QQ 通道）发送。
     * to 缺省依次取 ITERATE_MAIL_TO / EMAIL_FROM（发给自己），便于"每次 iterate 完成后推送邮箱"。
     */
    static async sendPlain(
        subject: string,
        text: string,
        to?: string,
        overrides?: Partial<Pick<EmailConfig, 'host' | 'port' | 'user' | 'pass' | 'from'>>,
        attachment?: { filename: string; content: string },
    ): Promise<void> {
        const isDev = process.env.NODE_ENV !== 'production';
        if (isDev) {
            console.log(`[Email][dev] ${subject} -> ${to ?? ''}${attachment ? `（附件 ${attachment.filename}）` : ''}（开发环境不真发邮件）`);
            return;
        }
        const cfg = readEmailConfig(overrides);
        if (!cfg) {
            throw new Error('邮箱服务未配置：请在环境变量设置 EMAIL_SMTP_USER / EMAIL_SMTP_PASS（见 .env.example）');
        }
        const transporter = nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port,
            secure: cfg.port === 465,
            auth: { user: cfg.user, pass: cfg.pass },
        });
        await transporter.sendMail({
            from: cfg.from,
            to: to || process.env.ITERATE_MAIL_TO || cfg.from,
            subject,
            text,
            ...(attachment
                ? { attachments: [{ filename: attachment.filename, content: attachment.content }] }
                : {}),
        });
    }
}
