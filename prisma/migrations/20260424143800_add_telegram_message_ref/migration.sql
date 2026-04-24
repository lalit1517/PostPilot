-- AlterTable
ALTER TABLE "Tweet" ADD COLUMN "telegram_chat_id" TEXT,
                    ADD COLUMN "telegram_message_id" INTEGER;
