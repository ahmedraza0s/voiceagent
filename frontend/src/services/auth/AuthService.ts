import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../../database/db';
import logger from '../../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_jwt_key_123!';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

export interface User {
    id: number;
    email: string;
    password: string;
    created_at: Date;
}

export class AuthService {
    async register(email: string, password: string): Promise<User> {
        const passwordHash = await bcrypt.hash(password, 10);
        try {
            const res = await query(
                'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING *',
                [email, passwordHash]
            );
            return res.rows[0];
        } catch (error) {
            logger.error('Error registering user', { email, error });
            throw error;
        }
    }

    async login(email: string, password: string): Promise<{ user: User; token: string }> {
        try {
            const res = await query('SELECT * FROM users WHERE email = $1', [email]);
            const user = res.rows[0];

            if (!user) {
                throw new Error('User not found');
            }

            const isValid = await bcrypt.compare(password, user.password);
            if (!isValid) {
                throw new Error('Invalid password');
            }

            const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
                expiresIn: JWT_EXPIRES_IN as any,
            });

            return { user, token };
        } catch (error) {
            logger.error('Error logging in user', { email, error });
            throw error;
        }
    }

    verifyToken(token: string): any {
        try {
            return jwt.verify(token, JWT_SECRET);
        } catch (error) {
            logger.error('Error verifying token', { error });
            throw error;
        }
    }
}

export const authService = new AuthService();
