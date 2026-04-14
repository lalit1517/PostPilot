import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Last 5 Tweets ---');
  const tweets = await prisma.tweet.findMany({
    orderBy: { created_at: 'desc' },
    take: 5,
    include: { versions: true }
  });
  console.log(JSON.stringify(tweets, null, 2));

  console.log('\n--- Recent Retry Queue Items ---');
  const retries = await prisma.retryQueue.findMany({
    orderBy: { created_at: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(retries, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
