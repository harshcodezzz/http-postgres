import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { JsonDB, type DataStore } from "../plugins/jsondb.js";

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");

  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;

  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

export default async function bootstrap(
  db: JsonDB = new JsonDB(),
): Promise<DataStore> {
  await db.ensureExists();

  const data = await db.read<DataStore>();

  if (data.admin?.hash) {
    console.log("[Bootstrap] Existing admin configuration loaded");
    return data;
  }

  const password = randomBytes(32).toString("base64url");
  const hash = await hashPassword(password);

  const updatedData: DataStore = {
    ...data,
    admin: { hash },
  };

  await db.write(updatedData);

  console.log("\n========================================");
  console.log("       GATEWAY ADMIN CREDENTIALS");
  console.log("========================================");
  console.log(`Username: admin`);
  console.log(`Password: ${password}`);
  console.log("Save this password. It will not be shown again.");
  console.log("========================================\n");

  return updatedData;
}
