import { loadConfig } from "./loader.js";
import { scopeKey, type QueryPrivilege } from "./query-privileges.js";

const config = loadConfig();

export default config;
export { config };

export function findQueryProfile(database: string, scopes: readonly QueryPrivilege[]) {
  const profiles = config.database.queryProfiles;
  if (!Object.hasOwn(profiles, database)) return;
  const key = scopeKey(scopes);
  return profiles[database].find((profile) => scopeKey(profile.scopes) === key);
}
