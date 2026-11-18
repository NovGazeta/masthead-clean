//process.env.PRIVATE_TURSO_PLATFORM_TOKEN
//PRIVATE_TURSO_DATABASE_URL
import { createClient } from "@libsql/client";

// Инициализация клиента Turso
export const turso = createClient({
  url: import.meta.env.PRIVATE_TURSO_DATABASE_URL || process.env.PRIVATE_TURSO_DATABASE_URL || "",
  authToken: import.meta.env.PRIVATE_TURSO_AUTH_TOKEN || process.env.PRIVATE_TURSO_AUTH_TOKEN || "",
});
