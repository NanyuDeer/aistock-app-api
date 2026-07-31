import dotenv from 'dotenv';
import { signJwt } from '../src/shared/utils/jwt';

dotenv.config({ path: '.env' });

const secret = process.env.JWT_SECRET;
if (!secret) {
    throw new Error('JWT_SECRET is missing from .env');
}

const now = Math.floor(Date.now() / 1000);
const token = signJwt({
    openid: 'trace_test_user_001',
    iat: now,
    exp: now + 60 * 60,
}, secret);

console.log(token);
