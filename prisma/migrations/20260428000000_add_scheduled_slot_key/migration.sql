ALTER TABLE "Tweet" ADD COLUMN "scheduled_slot_key" TEXT;

CREATE UNIQUE INDEX "Tweet_scheduled_slot_key_key" ON "Tweet"("scheduled_slot_key");
