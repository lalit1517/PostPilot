-- CreateTable
CREATE TABLE "Tweet" (
    "id" TEXT NOT NULL,
    "original_topic" TEXT NOT NULL,
    "edited_topic" TEXT,
    "time_of_day" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "x_tweet_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "intent_url" TEXT,
    "live_url" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tweet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TweetVersion" (
    "id" TEXT NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "critique" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TweetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "feedback_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetryQueue" (
    "id" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetryQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Engagement" (
    "id" TEXT NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "retweets" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Engagement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Engagement_tweet_id_key" ON "Engagement"("tweet_id");

-- AddForeignKey
ALTER TABLE "TweetVersion" ADD CONSTRAINT "TweetVersion_tweet_id_fkey" FOREIGN KEY ("tweet_id") REFERENCES "Tweet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_tweet_id_fkey" FOREIGN KEY ("tweet_id") REFERENCES "Tweet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_tweet_id_fkey" FOREIGN KEY ("tweet_id") REFERENCES "Tweet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
