/** QA 运行时只接受显式 true，避免误把生产进程切到隔离模式。 */
export function isQaMode(env: { QA_MODE?: string | undefined } = process.env): boolean {
    return env.QA_MODE === 'true';
}

/** QA 进程仍提供 HTTP/API，但不得注册任何后台任务。 */
export function shouldRunBackgroundJobs(
    env: { QA_MODE?: string | undefined } = process.env,
): boolean {
    return !isQaMode(env);
}
