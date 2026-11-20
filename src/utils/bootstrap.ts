import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { JsonDB, type DataStore } from "../plugins/jsondb.js";

const scryptAsync = promisify(scrypt);

export async function hashPassword(
  password: string,
  salt: string = randomBytes(16).toString("hex"),
): Promise<string> {
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;

  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  if (typeof password !== "string" || typeof storedHash !== "string") {
    return false;
  }

  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }

  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) {
    return false;
  }

  try {
    const computedHash = await hashPassword(password, salt);
    const computedHex = computedHash.split("$")[2];

    const computedBuffer = Buffer.from(computedHex, "hex");
    const expectedBuffer = Buffer.from(expectedHex, "hex");

    if (
      computedBuffer.length === 0 ||
      computedBuffer.length !== expectedBuffer.length
    ) {
      return false;
    }

    return timingSafeEqual(computedBuffer, expectedBuffer);
  } catch {
    return false;
  }
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
