import type { Config } from "drizzle-kit";
import * as dotenv from "dotenv";

// Load the right env file based on environment
if (process.env.NODE_ENV === "production") {
	dotenv.config({ path: ".env.production" });
} else {
	dotenv.config({ path: ".env.local" });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
	throw new Error("DATABASE_URL is required for database tooling");

export default {
	schema: "./src/lib/db/schema.ts",
	dialect: "postgresql",
	migrations: {
		table: "drizzle_migrations",
	},
	dbCredentials: {
		url: databaseUrl,
	},
	out: "./migrations",
	strict: process.env.NODE_ENV === "production",
} satisfies Config;
