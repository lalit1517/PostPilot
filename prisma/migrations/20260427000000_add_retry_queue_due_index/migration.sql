CREATE INDEX "RetryQueue_status_process_after_created_at_idx"
ON "RetryQueue" ("status", "process_after", "created_at");
