-- AlterTable: add quality_score to TweetVersion
ALTER TABLE "TweetVersion" ADD COLUMN "quality_score" DOUBLE PRECISION;

-- AlterTable: add weighted_score to Feedback
ALTER TABLE "Feedback" ADD COLUMN "weighted_score" DOUBLE PRECISION;

-- CreateTable: TweetOutcome
CREATE TABLE "TweetOutcome" (
    "id" TEXT NOT NULL,
    "tweet_id" TEXT NOT NULL,
    "outcome_score" DOUBLE PRECISION NOT NULL,
    "tier" TEXT NOT NULL,
    "peak_likes" INTEGER NOT NULL,
    "peak_retweets" INTEGER NOT NULL,
    "quality_score" DOUBLE PRECISION,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TweetOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PersonaProfile
CREATE TABLE "PersonaProfile" (
    "id" TEXT NOT NULL,
    "version" SERIAL NOT NULL,
    "profile_text" TEXT NOT NULL,
    "based_on_tweets" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PersonaProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable: LlmCallLog
CREATE TABLE "LlmCallLog" (
    "id" TEXT NOT NULL,
    "called_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "call_type" TEXT NOT NULL,

    CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique tweet_id on TweetOutcome
CREATE UNIQUE INDEX "TweetOutcome_tweet_id_key" ON "TweetOutcome"("tweet_id");

-- CreateIndex: called_at on LlmCallLog for rate limiting queries
CREATE INDEX "LlmCallLog_called_at_idx" ON "LlmCallLog"("called_at");

-- AddForeignKey: TweetOutcome -> Tweet (cascade delete)
ALTER TABLE "TweetOutcome" ADD CONSTRAINT "TweetOutcome_tweet_id_fkey" FOREIGN KEY ("tweet_id") REFERENCES "Tweet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
