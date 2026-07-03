import { Response } from 'express';

export interface ApiResponse<T = any> {
    code: number;
    message: string;
    data: T | null;
}

export function createResponse<T = any>(res: Response, code: number, message: string, data: T | null = null): Response {
    const body: ApiResponse<T> = { code, message, data };
    const httpStatus = (code >= 200 && code < 600) ? code : 200;
    return res.status(httpStatus).json(body);
}
