-- CreateTable
CREATE TABLE "auth_challenges" (
    "id" BIGSERIAL NOT NULL,
    "userId" BIGINT,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "token_hash" TEXT,
    "deep_link_hash" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "meta" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenges_token_hash_key" ON "auth_challenges"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_challenges_deep_link_hash_key" ON "auth_challenges"("deep_link_hash");

-- CreateIndex
CREATE INDEX "auth_challenges_target_channel_purpose_state_idx" ON "auth_challenges"("target", "channel", "purpose", "state");

-- CreateIndex
CREATE INDEX "auth_challenges_expires_at_idx" ON "auth_challenges"("expires_at");

-- AddForeignKey
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
