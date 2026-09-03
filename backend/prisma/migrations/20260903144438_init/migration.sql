-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('UP', 'DOWN');

-- CreateEnum
CREATE TYPE "ErrorType" AS ENUM ('TIMEOUT', 'DNS_FAIL', 'CONN_REFUSED', 'INVALID_URL', 'HTTP_ERROR', 'TLS_ERROR', 'UNKNOWN');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "urls" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "interval_seconds" INTEGER NOT NULL DEFAULT 300,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "urls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checks" (
    "id" BIGSERIAL NOT NULL,
    "url_id" TEXT NOT NULL,
    "status" "CheckStatus" NOT NULL,
    "status_code" INTEGER,
    "response_ms" INTEGER,
    "error_type" "ErrorType",
    "error_message" TEXT,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "url_stats_hourly" (
    "url_id" TEXT NOT NULL,
    "hour" TIMESTAMP(3) NOT NULL,
    "total_checks" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "avg_ms" DOUBLE PRECISION,
    "p95_ms" INTEGER,

    CONSTRAINT "url_stats_hourly_pkey" PRIMARY KEY ("url_id","hour")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "urls_user_id_idx" ON "urls"("user_id");

-- CreateIndex
CREATE INDEX "urls_is_active_idx" ON "urls"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "urls_user_id_url_key" ON "urls"("user_id", "url");

-- CreateIndex
CREATE INDEX "checks_url_id_checked_at_idx" ON "checks"("url_id", "checked_at" DESC);

-- CreateIndex
CREATE INDEX "checks_checked_at_idx" ON "checks"("checked_at");

-- CreateIndex
CREATE INDEX "url_stats_hourly_hour_idx" ON "url_stats_hourly"("hour");

-- AddForeignKey
ALTER TABLE "urls" ADD CONSTRAINT "urls_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checks" ADD CONSTRAINT "checks_url_id_fkey" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_stats_hourly" ADD CONSTRAINT "url_stats_hourly_url_id_fkey" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
