-- AlterTable
ALTER TABLE "TweetOutcome" ADD COLUMN "topic" TEXT;
ALTER TABLE "TweetOutcome" ADD COLUMN "time_of_day" TEXT;
ALTER TABLE "TweetOutcome" ADD COLUMN "day_of_week" TEXT;

-- CreateIndex
CREATE INDEX "TweetOutcome_tier_computed_at_idx" ON "TweetOutcome"("tier", "computed_at");
CREATE INDEX "TweetOutcome_time_of_day_idx" ON "TweetOutcome"("time_of_day");
CREATE INDEX "TweetOutcome_day_of_week_idx" ON "TweetOutcome"("day_of_week");
