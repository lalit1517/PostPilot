import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
});

// Helpful advice if the connection pool times out
prisma.$on('error', (e: any) => {
  if (e.message?.includes('connection pool')) {
    console.error('CRITICAL: Prisma connection pool exhausted. Ensure your DATABASE_URL includes &connection_limit=20');
  }
});
