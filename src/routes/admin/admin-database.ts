import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  listPostgresDatabases,
  getPostgresDatabaseDetails,
  getPostgresDatabaseOid,
  createPostgresDatabase,
  alterPostgresDatabase,
  deletePostgresDatabase,
  refreshPostgresDatabaseVersion,
  isValidDatabaseName,
  listPostgresTables,
  withPostgresDatabase,
  DatabaseError,
} from "../../utils/pg-database.js";

export interface CreateDatabaseBody {
  name?: string;
  database?: string;
  owner?: string;
  template?: string;
  encoding?: string;
  lcCollate?: string;
  lc_collate?: string;
  lcCtype?: string;
  lc_ctype?: string;
  tablespace?: string;
  connectionLimit?: number;
  connection_limit?: number;
}

export interface AlterDatabaseBody {
  newName?: string;
  name?: string;
  owner?: string;
  allowConnections?: unknown;
  allow_connections?: unknown;
  connectionLimit?: number;
  connection_limit?: number;
  settings?: Record<string, string>;
  resetSettings?: string[];
  reset_settings?: string[];
}

function mapDatabaseErrorStatus(code: string): number {
  switch (code) {
    case "DATABASE_NOT_FOUND":
      return 404;
    case "DATABASE_ALREADY_EXISTS":
    case "DATABASE_IN_USE":
      return 409;
    case "PROTECTED_DATABASE":
    case "INSUFFICIENT_PRIVILEGE":
      return 403;
    case "DATABASE_VERSION_UNSUPPORTED":
      return 422;
    case "INVALID_PARAMETER_VALUE":
    case "DATABASE_REQUIRED":
    case "INVALID_DATABASE_NAME":
    case "INVALID_REQUEST_BODY":
      return 400;
    case "PARTIAL_RENAME_METADATA_SYNC_FAILED":
    case "PARTIAL_DELETE_METADATA_SYNC_FAILED":
    case "PARTIAL_CREATE_ACCESS_SETUP_FAILED":
      return 500;
    default:
      return 400;
  }
}

function sendErrorReply(
  reply: FastifyReply,
  err: unknown,
  log: { error: (err: unknown, msg?: string) => void },
  logMessage: string,
  fallbackMessage: string,
) {
  if (err instanceof DatabaseError) {
    const statusCode = mapDatabaseErrorStatus(err.code);
    if (statusCode >= 500) {
      log.error(err, logMessage);
    }
    return reply.code(statusCode).send({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  log.error(err, logMessage);
  return reply.code(500).send({
    success: false,
    error: {
      code: "DATABASE_ERROR",
      message: fallbackMessage,
    },
  });
}

function getField(obj: Record<string, unknown>, camel: string, snake: string): unknown {
  if (camel in obj) return obj[camel];
  if (snake in obj) return obj[snake];
  return undefined;
}

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "1") return true;
    if (lower === "false" || lower === "0") return false;
  }
  throw new DatabaseError(`'${fieldName}' must be a boolean`, "INVALID_PARAMETER_VALUE");
}

function parseOptionalInteger(
  value: unknown,
  fieldName: string,
  min?: number,
): number | undefined {
  if (value === undefined) return undefined;
  let num: number;
  if (typeof value === "number") {
    num = value;
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    num = parseInt(value.trim(), 10);
  } else {
    throw new DatabaseError(`'${fieldName}' must be an integer`, "INVALID_PARAMETER_VALUE");
  }
  if (!Number.isInteger(num)) {
    throw new DatabaseError(`'${fieldName}' must be an integer`, "INVALID_PARAMETER_VALUE");
  }
  if (min !== undefined && num < min) {
    throw new DatabaseError(
      `'${fieldName}' must be an integer greater than or equal to ${min}`,
      "INVALID_PARAMETER_VALUE",
    );
  }
  return num;
}

function parseOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new DatabaseError(`'${fieldName}' must be a string`, "INVALID_PARAMETER_VALUE");
}

function parseOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  throw new DatabaseError(`'${fieldName}' must be an array of strings`, "INVALID_PARAMETER_VALUE");
}

function parseOptionalRecord(value: unknown, fieldName: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new DatabaseError(
          `Values in '${fieldName}' must be strings`,
          "INVALID_PARAMETER_VALUE",
        );
      }
      record[k] = String(v);
    }
    return record;
  }
  throw new DatabaseError(`'${fieldName}' must be an object`, "INVALID_PARAMETER_VALUE");
}

const adminDatabaseRoutes: FastifyPluginAsync = async (fastify) => {
  const listDatabases = async (reply: FastifyReply, includeTemplates: boolean) => {
    try {
      const databases = await listPostgresDatabases(fastify.db, includeTemplates);
      return {
        success: true,
        count: databases.length,
        databases,
      };
    } catch (err: unknown) {
      return sendErrorReply(
        reply,
        err,
        fastify.log,
        "Failed to list databases",
        "Failed to list databases",
      );
    }
  };
  fastify.get("/database", (_request, reply) => listDatabases(reply, true));
  fastify.get("/databases", (_request, reply) => listDatabases(reply, false));

  type DatabaseLookup = { Params: { id: string }; Querystring: { by?: string } };
  const getDatabase = async (request: FastifyRequest<DatabaseLookup>, reply: FastifyReply, includeTemplates: boolean) => {
    const { id } = request.params;
    try {
      const { by } = request.query;
      if (by !== undefined && by !== "id" && by !== "name") {
        throw new DatabaseError("Use 'id' or 'name' for the by query parameter", "INVALID_PARAMETER_VALUE");
      }
      const details = await getPostgresDatabaseDetails(id, fastify.db, includeTemplates, by === "id" ? "id" : "name");

      if (!details) {
        return reply.code(404).send({
          success: false,
          error: {
            code: "DATABASE_NOT_FOUND",
            message: `Database '${id}' not found`,
          },
        });
      }

      return {
        success: true,
        database: details,
      };
    } catch (err: unknown) {
      return sendErrorReply(
        reply,
        err,
        fastify.log,
        "Failed to retrieve database details",
        "Failed to retrieve database details",
      );
    }
  };
  fastify.get<DatabaseLookup>("/database/:id", (request, reply) => getDatabase(request, reply, true));
  fastify.get<DatabaseLookup>("/databases/:id", (request, reply) => getDatabase(request, reply, false));

  const createHandler = async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply: FastifyReply) => {
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const rawName = getField(body, "name", "database");

    if (rawName === undefined || rawName === null || typeof rawName !== "string" || rawName.trim() === "") {
      return reply.code(400).send({
        success: false,
        error: {
          code: "INVALID_DATABASE_NAME",
          message: "Database name is required in 'name' or 'database'",
        },
      });
    }

    try {
      const owner = parseOptionalString(getField(body, "owner", "owner"), "owner");
      const template = parseOptionalString(getField(body, "template", "template"), "template");
      const encoding = parseOptionalString(getField(body, "encoding", "encoding"), "encoding");
      const lcCollate = parseOptionalString(getField(body, "lcCollate", "lc_collate"), "lcCollate");
      const lcCtype = parseOptionalString(getField(body, "lcCtype", "lc_ctype"), "lcCtype");
      const tablespace = parseOptionalString(getField(body, "tablespace", "tablespace"), "tablespace");
      const connectionLimit = parseOptionalInteger(
        getField(body, "connectionLimit", "connection_limit"),
        "connectionLimit",
        -1,
      );

      await createPostgresDatabase(
        {
          name: rawName.trim(),
          owner,
          template,
          encoding,
          lcCollate,
          lcCtype,
          tablespace,
          connectionLimit,
        },
        fastify.db,
      );

      return reply.code(201).send({
        success: true,
        message: `Database '${rawName.trim()}' created successfully`,
        database: rawName.trim(),
      });
    } catch (err: unknown) {
      return sendErrorReply(
        reply,
        err,
        fastify.log,
        "Failed to create database",
        "Failed to create database",
      );
    }
  };
  fastify.post("/database", createHandler);
  fastify.post("/databases", createHandler);

  fastify.get("/table", async (request, reply) => {
    const database = request.headers["x-database"];
    try {
      if (database === undefined) {
        throw new DatabaseError("The x-database header is required", "DATABASE_REQUIRED");
      }
      if (!isValidDatabaseName(database)) {
        throw new DatabaseError("A valid database name is required in x-database", "INVALID_DATABASE_NAME");
      }
      const oid = await getPostgresDatabaseOid(database, fastify.db);
      if (!oid) throw new DatabaseError(`Database '${database}' not found`, "DATABASE_NOT_FOUND");
      const tables = await withPostgresDatabase(database, async (client) => {
        if (await getPostgresDatabaseOid(database, client) !== oid) {
          throw new DatabaseError("Database identity changed while listing tables", "DATABASE_IN_USE");
        }
        return listPostgresTables(client);
      });
      return { success: true, database, count: tables.length, tables };
    } catch (err) {
      return sendErrorReply(reply, err, fastify.log, "Failed to list tables", "Failed to list tables");
    }
  });

  function databaseTarget(request: FastifyRequest<{ Body: Record<string, unknown> }>) {
    const hasExplicitId = request.body?.id != null && request.body?.database == null && request.headers["x-database"] == null && request.body?.name == null;
    const by = hasExplicitId ? ("id" as const) : ("name" as const);
    const target = (by === "id" ? request.body?.id : (request.body?.database ?? request.headers["x-database"] ?? request.body?.name)) as string | undefined;
    if (typeof target !== "string" || !target) {
      throw new DatabaseError(by === "id" ? "A database ID is required" : "A database name is required", "INVALID_DATABASE_NAME");
    }
    return { target, by } as const;
  }

  fastify.put<{ Body: Record<string, unknown> }>("/database", async (request, reply) => {
    try {
      if (request.body?.version !== undefined && request.body.version !== "collation") {
        throw new DatabaseError("Use version 'collation' to refresh the database collation version", "DATABASE_VERSION_UNSUPPORTED");
      }
      const { target, by } = databaseTarget(request);
      const database = await getPostgresDatabaseDetails(target, fastify.db, false, by);
      if (!database) throw new DatabaseError(`Database '${target}' not found`, "DATABASE_NOT_FOUND");
      const updated = await fastify.queryPools.withMaintenance(
        database.name, () => refreshPostgresDatabaseVersion(database, fastify.db),
      );
      return { success: true, database: updated };
    } catch (err) {
      return sendErrorReply(reply, err, fastify.log, "Failed to refresh database version", "Failed to refresh database version");
    }
  });

  const alterHandler = async (
    request: FastifyRequest<{
      Params: { name?: string };
      Body: Record<string, unknown>;
    }>,
    reply: FastifyReply,
  ) => {
    const body = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;

    try {
      const pathName = request.params.name;
      const { target, by } = pathName ? { target: pathName, by: "name" as const } : databaseTarget(request);
      const details = pathName ? null : await getPostgresDatabaseDetails(target, fastify.db, false, by);
      if (!pathName && !details) throw new DatabaseError(`Database '${target}' not found`, "DATABASE_NOT_FOUND");
      const dbName = details?.name ?? target;
      const newName = parseOptionalString(pathName ? getField(body, "newName", "name") : body.newName, "newName");
      const owner = parseOptionalString(getField(body, "owner", "owner"), "owner");
      const allowConnections = parseOptionalBoolean(
        getField(body, "allowConnections", "allow_connections"),
        "allowConnections",
      );
      const connectionLimit = parseOptionalInteger(
        getField(body, "connectionLimit", "connection_limit"),
        "connectionLimit",
        -1,
      );
      const settings = parseOptionalRecord(getField(body, "settings", "settings"), "settings");
      const resetSettings = parseOptionalStringArray(
        getField(body, "resetSettings", "reset_settings"),
        "resetSettings",
      );

      const alter = () => alterPostgresDatabase(
        dbName,
        {
          newName,
          owner,
          allowConnections,
          connectionLimit,
          settings,
          resetSettings,
        },
        fastify.db,
        fastify.jsondb,
        details?.id,
      );

      const result = newName && newName !== dbName
        ? await fastify.queryPools.withMaintenance(dbName, alter)
        : await alter();

      const targetName = result.renamed ? result.database : dbName;

      return {
        success: true,
        message: `Database '${targetName}' properties updated successfully`,
        database: result.database,
        renamed: result.renamed,
      };
    } catch (err: unknown) {
      return sendErrorReply(
        reply,
        err,
        fastify.log,
        "Failed to alter database",
        "Failed to alter database",
      );
    }
  };

  fastify.patch<{ Params: { name?: string }; Body: Record<string, unknown> }>("/database", alterHandler);

  fastify.patch<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>("/databases/:name", alterHandler);

  fastify.put<{
    Params: { name: string };
    Body: Record<string, unknown>;
  }>("/databases/:name", alterHandler);

  fastify.delete<{
    Params: { name: string };
    Querystring: { force?: unknown };
  }>("/databases/:name", async (request, reply) => {
    const dbName = request.params.name;
    const rawForce = request.query?.force;

    let isForce = false;
    if (rawForce !== undefined) {
      if (typeof rawForce === "boolean") {
        isForce = rawForce;
      } else if (typeof rawForce === "string") {
        const lower = rawForce.trim().toLowerCase();
        if (lower === "true" || lower === "1") {
          isForce = true;
        } else if (lower === "false" || lower === "0" || lower === "") {
          isForce = false;
        } else {
          return reply.code(400).send({
            success: false,
            error: {
              code: "INVALID_PARAMETER_VALUE",
              message: "Query parameter 'force' must be a boolean",
            },
          });
        }
      } else {
        return reply.code(400).send({
          success: false,
          error: {
            code: "INVALID_PARAMETER_VALUE",
            message: "Query parameter 'force' must be a boolean",
          },
        });
      }
    }

    try {
      await fastify.queryPools.withMaintenance(
        dbName,
        () => deletePostgresDatabase(dbName, fastify.db, isForce, fastify.jsondb),
        isForce,
      );
      return {
        success: true,
        message: `Database '${dbName}' deleted successfully`,
      };
    } catch (err: unknown) {
      return sendErrorReply(
        reply,
        err,
        fastify.log,
        "Failed to delete database",
        "Failed to delete database",
      );
    }
  });
};

export default adminDatabaseRoutes;
