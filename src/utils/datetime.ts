export function formatToChinaTime(timestamp: number): string {
    const date = new Date(timestamp);
    const utc8Time = date.getTime() + (date.getTimezoneOffset() * 60000) + (8 * 3600000);
    const d = new Date(utc8Time);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
