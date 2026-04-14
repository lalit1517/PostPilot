import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const tweet = await prisma.tweet.findFirst({
    orderBy: { created_at: 'desc' }
  });
  if (tweet) {
    console.log(`Latest Tweet: ID=${tweet.id}, Topic=${tweet.original_topic}, CreatedAt=${tweet.created_at}`);
  } else {
    console.log("No tweets found.");
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
