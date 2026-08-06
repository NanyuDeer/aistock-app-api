import { shanghaiDateTimeStr } from './shanghaiTime';

/** 将毫秒时间戳格式化为上海时区时间字符串 YYYY-MM-DD HH:mm:ss（统一走 shanghaiTime 通用函数） */
export function formatToChinaTime(timestamp: number): string {
    return shanghaiDateTimeStr(timestamp);
}
