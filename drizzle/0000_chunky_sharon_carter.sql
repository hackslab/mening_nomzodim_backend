CREATE TABLE "sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone_number" text NOT NULL,
	"session_string" text NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "sessions_phone_number_unique" UNIQUE("phone_number")
);
