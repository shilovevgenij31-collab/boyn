CREATE TYPE "public"."telegram_user_role" AS ENUM('USER', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."telegram_user_status" AS ENUM('PENDING', 'ACTIVE', 'DENIED');--> statement-breakpoint
CREATE TABLE "telegram_users" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"chat_id" bigint,
	"username" text,
	"first_name" text,
	"role" "telegram_user_role" DEFAULT 'USER' NOT NULL,
	"status" "telegram_user_status" DEFAULT 'PENDING' NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" bigint,
	"updated_at" timestamp with time zone NOT NULL
);
