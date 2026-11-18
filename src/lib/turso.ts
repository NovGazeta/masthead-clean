import { createClient } from "@libsql/client";
import "dotenv/config";

// Инициализация клиента Turso
export const turso = createClient({
  url: process.env.PRIVATE_TURSO_DATABASE_URL,
  authToken: process.env.PRIVATE_TURSO_AUTH_TOKEN,
});
