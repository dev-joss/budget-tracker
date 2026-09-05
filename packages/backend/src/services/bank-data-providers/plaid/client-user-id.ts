import { createHmac } from 'node:crypto';

export const plaidClientUserId = ({ userId, secret }: { userId: number; secret: string }): string =>
  createHmac('sha256', secret).update(String(userId)).digest('hex');
