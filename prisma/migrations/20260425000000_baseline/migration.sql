-- CreateTable
CREATE TABLE "Tweet" (
    "id" TEXT NOT NULL,
    "original_topic" TEXT NOT NULL,
    "edited_topic" TEXT,
    "time_of_day" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "posted" BOOLEAN NOT NULL DEFAULT false,
    "x_tweet_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "intent_url" TEXT,
    "live_url" TEXT,
    "fingerprint" TEXT,
    "posted_at" TIMESTAMP(3),
    "telegram_chat_id" TEXT,
    "telegram_message_id" INTEGER,
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
    "quality_score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TweetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "feedback_text" TEXT NOT NULL,
    "weighted_score" DOUBLE PRECISION,
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
    "process_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    "replies" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Engagement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TweetOutcome" (
    "id" TEXT NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "outcome_score" DOUBLE PRECISION NOT NULL,
    "tier" TEXT NOT NULL,
    "peak_likes" INTEGER NOT NULL,
    "peak_retweets" INTEGER NOT NULL,
    "peak_replies" INTEGER NOT NULL DEFAULT 0,
    "quality_score" DOUBLE PRECISION,
    "topic" TEXT,
    "time_of_day" TEXT,
    "day_of_week" TEXT,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TweetOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonaProfile" (
    "id" TEXT NOT NULL,
    "version" SERIAL NOT NULL,
    "profile_text" TEXT NOT NULL,
    "based_on_tweets" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PersonaProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCallLog" (
    "id" TEXT NOT NULL,
    "called_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "call_type" TEXT NOT NULL,

    CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tweet_fingerprint_key" ON "Tweet"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "TweetOutcome_tweet_id_key" ON "TweetOutcome"("tweet_id");

-- CreateIndex
CREATE INDEX "TweetOutcome_tier_computed_at_idx" ON "TweetOutcome"("tier", "computed_at");

-- CreateIndex
CREATE INDEX "TweetOutcome_time_of_day_idx" ON "TweetOutcome"("time_of_day");

-- CreateIndex
CREATE INDEX "TweetOutcome_day_of_week_idx" ON "TweetOutcome"("day_of_week");

-- CreateIndex
CREATE INDEX "LlmCallLog_called_at_idx" ON "LlmCallLog"("called_at");

-- AddForeignKey
ALTER TABLE "TweetVersion" ADD CONSTRAINT "TweetVersion_tweet_id_fkey" FOREIGN KEY ("tweet_id") REFERENCES "Tweet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_tweet_id_fkey" FOREIGN KEY ("tweet_id") REFERENCES "Tweet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Engagement" ADD CONSTRAINT "Engagement_tweet_id_fkey" FOREIGN KEY ("tweet_id") REFERENCES "Tweet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TweetOutcome" ADD CONSTRAINT "TweetOutcome_tweet_id_fkey" FOREIGN KEY ("tweet_id") REFERENCES "Tweet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

