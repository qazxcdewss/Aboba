/*
  Warnings:

  - Added the required column `token_hash` to the `Session` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "token_hash" TEXT NOT NULL;
